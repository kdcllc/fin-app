//! App-owned SQLite backend: one `rusqlite` connection per book behind a
//! mutex in Tauri managed state, a `PRAGMA user_version`-based migration
//! runner over the shipped `migrations/*.sql` files, and the IPC commands
//! `open_book`, `db_select`, `db_execute`, and `db_batch`.
//!
//! Replaces `tauri-plugin-sql`, whose sqlx connection pool spread
//! `BEGIN`/`COMMIT` across different connections and silently lost
//! transactional writes (upstream tauri-apps/plugins-workspace#886). Here
//! every statement for a book runs on the same connection, and `db_batch`
//! executes a whole statement list inside one real transaction in a single
//! IPC round trip.
//!
//! SQL strings live in the TS core layer; this backend is a dumb executor.
//! Amounts are integer cents (JSON integers) — never floats.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map as JsonMap, Value as JsonValue};
use tauri::State;

/// All schema migrations in order: (`user_version` after applying, SQL).
/// Every future schema change is appended here as a new version — never edit
/// an already-shipped migration file.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/0001_schema_v1.sql")),
    (2, include_str!("../migrations/0002_prove_migration_path.sql")),
    (3, include_str!("../migrations/0003_import_idempotency.sql")),
    (4, include_str!("../migrations/0004_category_archiving.sql")),
    (5, include_str!("../migrations/0005_recurring_dashboard.sql")),
    (6, include_str!("../migrations/0006_recurring_anchor_fields.sql")),
];

/// Typed errors for the SQLite backend. Serialized as their `Display` string
/// across the IPC boundary; SQLite failures keep the canonical SQLite message
/// text (e.g. "FOREIGN KEY constraint failed", "database is locked") so the
/// TS `mapSqliteError` keeps matching.
#[derive(Debug)]
pub enum BackendError {
    /// `open_book` was called with a relative path.
    PathNotAbsolute(String),
    /// A different book is already open this session.
    BookAlreadyOpen { open_path: String },
    /// A `db_*` command was invoked before `open_book`.
    NoBookOpen,
    /// The file was created by the plugin-era backend (app tables present but
    /// `user_version = 0`); it cannot be migrated.
    LegacyBookFile { path: String },
    /// A parameter had a JSON type outside null/integer/real/text/bool.
    UnsupportedParamType { index: usize, kind: &'static str },
    /// A statement inside `db_batch` failed; the whole batch was rolled back.
    BatchStatementFailed { index: usize, message: String },
    /// Any SQLite-level failure; message is SQLite's own text.
    Sqlite(String),
    /// Filesystem failure while materializing the book file.
    Io(String),
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PathNotAbsolute(path) => {
                write!(f, "book path must be absolute, got: {path}")
            }
            Self::BookAlreadyOpen { open_path } => write!(
                f,
                "a book is already open this session ({open_path}); restart the app to switch books"
            ),
            Self::NoBookOpen => write!(f, "no book is open; call open_book first"),
            Self::LegacyBookFile { path } => write!(
                f,
                "the book file {path} was created by an older version of fin-app and cannot be \
                 upgraded; please choose a new (or empty) book file"
            ),
            Self::UnsupportedParamType { index, kind } => write!(
                f,
                "unsupported SQL parameter type at index {index}: {kind} \
                 (allowed: null, integer, real, text, bool)"
            ),
            Self::BatchStatementFailed { index, message } => {
                write!(f, "batch statement {index} failed: {message}")
            }
            Self::Sqlite(message) => write!(f, "{message}"),
            Self::Io(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for BackendError {}

impl Serialize for BackendError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<rusqlite::Error> for BackendError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error.to_string())
    }
}

/// The book open in this session, if any: its absolute path and the single
/// connection all statements share.
struct Book {
    path: PathBuf,
    conn: Connection,
}

/// Tauri managed state: at most one open book per session (same rule as the
/// plugin-era `RegisteredBook`); switching books requires a restart.
pub struct OpenBookState(Mutex<Option<Book>>);

impl OpenBookState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

impl Default for OpenBookState {
    fn default() -> Self {
        Self::new()
    }
}

/// Result of a single write statement, as the frontend consumes it.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub rows_affected: u64,
    pub last_insert_id: i64,
}

/// One statement inside a `db_batch` call.
#[derive(Debug, Deserialize)]
pub struct BatchStatement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<JsonValue>,
}

// ---------------------------------------------------------------------------
// Commands (thin wrappers; logic lives in the `_impl` functions below so it
// is testable without a Tauri runtime).
// ---------------------------------------------------------------------------

/// Open (and if needed create + migrate) the book at `path`, an absolute path
/// to the SQLite file. Idempotent for the same path; a different path in the
/// same session is rejected. Returns the path back on success.
///
/// All DB commands are `(async)` so Tauri runs them on its background thread
/// pool instead of the main thread — SQLite work (and waiting on the book
/// mutex) must never block the UI.
#[tauri::command(async)]
pub fn open_book(state: State<'_, OpenBookState>, path: String) -> Result<String, BackendError> {
    open_book_impl(&state, &path)
}

/// Run a read statement and return the rows as JSON objects keyed by column
/// name.
#[tauri::command(async)]
pub fn db_select(
    state: State<'_, OpenBookState>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<Vec<JsonMap<String, JsonValue>>, BackendError> {
    with_conn(&state, |conn| select_impl(conn, &sql, &params))
}

/// Run a single write statement.
#[tauri::command(async)]
pub fn db_execute(
    state: State<'_, OpenBookState>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<ExecResult, BackendError> {
    with_conn(&state, |conn| execute_impl(conn, &sql, &params))
}

/// Run every statement inside ONE transaction on the book's single
/// connection. On any failure the whole batch is rolled back and the error
/// names the failing statement index plus the SQLite message.
#[tauri::command(async)]
pub fn db_batch(
    state: State<'_, OpenBookState>,
    statements: Vec<BatchStatement>,
) -> Result<Vec<ExecResult>, BackendError> {
    with_conn(&state, |conn| batch_impl(conn, &statements))
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

fn with_conn<T>(
    state: &OpenBookState,
    f: impl FnOnce(&mut Connection) -> Result<T, BackendError>,
) -> Result<T, BackendError> {
    let mut guard = state.0.lock().expect("OpenBookState mutex poisoned");
    let book = guard.as_mut().ok_or(BackendError::NoBookOpen)?;
    f(&mut book.conn)
}

fn open_book_impl(state: &OpenBookState, path: &str) -> Result<String, BackendError> {
    let book_path = PathBuf::from(path);
    if !book_path.is_absolute() {
        return Err(BackendError::PathNotAbsolute(path.to_string()));
    }

    let mut guard = state.0.lock().expect("OpenBookState mutex poisoned");
    if let Some(book) = guard.as_ref() {
        if book.path == book_path {
            return Ok(path.to_string());
        }
        return Err(BackendError::BookAlreadyOpen {
            open_path: book.path.display().to_string(),
        });
    }

    crate::materialize_book_file(&book_path).map_err(BackendError::Io)?;
    let conn = open_book_connection(&book_path)?;

    *guard = Some(Book {
        path: book_path,
        conn,
    });
    Ok(path.to_string())
}

/// Open the connection for a book file: legacy-file guard first (pure reads,
/// so a rejected file is left byte-identical), then session PRAGMAs, then
/// pending migrations.
fn open_book_connection(path: &Path) -> Result<Connection, BackendError> {
    let mut conn = Connection::open(path)?;

    assert_not_legacy_book(&conn, path)?;

    conn.busy_timeout(Duration::from_millis(5000))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // journal_mode is the one PRAGMA that writes to the file header, so it
    // runs only after the legacy guard has accepted the file.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;

    run_migrations(&mut conn)?;
    Ok(conn)
}

fn user_version(conn: &Connection) -> Result<i64, BackendError> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

/// Reject plugin-era book files. Those have app tables but `user_version = 0`
/// (the plugin tracked migrations in its own `_sqlx_migrations` table), so
/// blindly running migration 0001 would fail mid-way with "table already
/// exists". An empty file with `user_version = 0` is the normal fresh
/// bootstrap and passes.
fn assert_not_legacy_book(conn: &Connection, path: &Path) -> Result<(), BackendError> {
    if user_version(conn)? != 0 {
        return Ok(());
    }
    let has_payments_table: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'payments')",
        [],
        |row| row.get(0),
    )?;
    if has_payments_table {
        return Err(BackendError::LegacyBookFile {
            path: path.display().to_string(),
        });
    }
    Ok(())
}

/// Apply every migration whose version is greater than the file's current
/// `PRAGMA user_version`, each in its own transaction, setting
/// `user_version = N` after each. Re-running on a fully migrated file is a
/// no-op.
fn run_migrations(conn: &mut Connection) -> Result<(), BackendError> {
    let current = user_version(conn)?;
    for (version, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)
            .map_err(|e| BackendError::Sqlite(format!("migration {version} failed: {e}")))?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}

/// Map one JSON parameter to a SQLite value. Only null/integer/real/text/bool
/// are accepted; amounts arrive as integer cents.
fn json_param_to_sql(value: &JsonValue, index: usize) -> Result<SqlValue, BackendError> {
    match value {
        JsonValue::Null => Ok(SqlValue::Null),
        JsonValue::Bool(b) => Ok(SqlValue::Integer(i64::from(*b))),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(SqlValue::Integer(i))
            } else if n.is_f64() {
                // as_f64 is always Some for an f64-backed number.
                Ok(SqlValue::Real(n.as_f64().expect("f64-backed JSON number")))
            } else {
                Err(BackendError::UnsupportedParamType {
                    index,
                    kind: "integer out of i64 range",
                })
            }
        }
        JsonValue::String(s) => Ok(SqlValue::Text(s.clone())),
        JsonValue::Array(_) => Err(BackendError::UnsupportedParamType {
            index,
            kind: "array",
        }),
        JsonValue::Object(_) => Err(BackendError::UnsupportedParamType {
            index,
            kind: "object",
        }),
    }
}

fn json_params(params: &[JsonValue]) -> Result<Vec<SqlValue>, BackendError> {
    params
        .iter()
        .enumerate()
        .map(|(index, value)| json_param_to_sql(value, index))
        .collect()
}

/// Map one SQLite column value to JSON. BLOB columns are not part of the app
/// schema and are rejected rather than silently mangled.
fn column_value_to_json(value: ValueRef<'_>, column: &str) -> Result<JsonValue, BackendError> {
    match value {
        ValueRef::Null => Ok(JsonValue::Null),
        ValueRef::Integer(i) => Ok(JsonValue::from(i)),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(JsonValue::Number).ok_or_else(|| {
            BackendError::Sqlite(format!(
                "column {column} holds a non-finite REAL value that JSON cannot represent"
            ))
        }),
        ValueRef::Text(bytes) => match std::str::from_utf8(bytes) {
            Ok(s) => Ok(JsonValue::from(s)),
            Err(e) => Err(BackendError::Sqlite(format!(
                "column {column} holds invalid UTF-8 text: {e}"
            ))),
        },
        ValueRef::Blob(_) => Err(BackendError::Sqlite(format!(
            "column {column} is a BLOB, which db_select does not support"
        ))),
    }
}

fn select_impl(
    conn: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<Vec<JsonMap<String, JsonValue>>, BackendError> {
    let sql_params = json_params(params)?;
    let mut stmt = conn.prepare(sql)?;
    let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let mut rows = stmt.query(params_from_iter(sql_params))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut object = JsonMap::with_capacity(column_names.len());
        for (i, name) in column_names.iter().enumerate() {
            object.insert(name.clone(), column_value_to_json(row.get_ref(i)?, name)?);
        }
        out.push(object);
    }
    Ok(out)
}

fn execute_impl(
    conn: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<ExecResult, BackendError> {
    let sql_params = json_params(params)?;
    let rows_affected = conn.prepare(sql)?.execute(params_from_iter(sql_params))? as u64;
    Ok(ExecResult {
        rows_affected,
        last_insert_id: conn.last_insert_rowid(),
    })
}

fn batch_impl(
    conn: &mut Connection,
    statements: &[BatchStatement],
) -> Result<Vec<ExecResult>, BackendError> {
    let tx = conn.transaction()?;
    let mut results = Vec::with_capacity(statements.len());
    for (index, statement) in statements.iter().enumerate() {
        // Returning early drops `tx`, which rolls back every prior statement.
        let result = execute_impl(&tx, &statement.sql, &statement.params).map_err(|e| {
            BackendError::BatchStatementFailed {
                index,
                message: e.to_string(),
            }
        })?;
        results.push(result);
    }
    tx.commit()?;
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// The `user_version` a fully migrated book reports.
    const LATEST_VERSION: i64 = MIGRATIONS[MIGRATIONS.len() - 1].0;

    /// Tables migration 0001–0006 must leave behind.
    const EXPECTED_TABLES: &[&str] = &[
        "accounts",
        "categories",
        "import_log",
        "payees",
        "payments",
        "recurring_bill_suggestion_dismissals",
        "recurring_bills",
    ];

    struct TempBook {
        root: PathBuf,
        path: PathBuf,
    }

    impl TempBook {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time went backwards")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "fin-app-db-{label}-{nanos}-{}",
                std::process::id()
            ));
            let path = root.join("book.db");
            Self { root, path }
        }

        fn path_str(&self) -> String {
            self.path.display().to_string()
        }
    }

    impl Drop for TempBook {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// Open the book at `path` in a fresh session (fresh state) and return
    /// the state for further use.
    fn open_session(path: &str) -> OpenBookState {
        let state = OpenBookState::new();
        open_book_impl(&state, path).expect("open_book should succeed");
        state
    }

    fn inspect(path: &Path) -> Connection {
        Connection::open(path).expect("inspection connection should open")
    }

    fn table_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .expect("sqlite_master query should prepare");
        stmt.query_map([], |row| row.get(0))
            .expect("sqlite_master query should run")
            .collect::<Result<Vec<String>, _>>()
            .expect("sqlite_master rows should read")
    }

    fn count(state: &OpenBookState, table: &str) -> i64 {
        let rows = with_conn(state, |conn| {
            select_impl(conn, &format!("SELECT COUNT(*) AS n FROM {table}"), &[])
        })
        .expect("count query should succeed");
        rows[0]["n"].as_i64().expect("count should be an integer")
    }

    // -- open_book: fresh bootstrap & migrations ---------------------------

    #[test]
    fn open_book_on_fresh_path_migrates_to_latest_version_with_all_tables() {
        let book = TempBook::new("fresh");
        let _state = open_session(&book.path_str());

        assert!(book.path.is_file(), "book file should have been created");
        let conn = inspect(&book.path);
        assert_eq!(
            user_version(&conn).unwrap(),
            LATEST_VERSION,
            "fresh book should be migrated to the latest user_version"
        );
        assert_eq!(table_names(&conn), EXPECTED_TABLES);
    }

    #[test]
    fn open_book_is_idempotent_across_sessions() {
        let book = TempBook::new("reopen");
        drop(open_session(&book.path_str()));

        // Second session on the already-migrated file: no error, no change.
        let _state = open_session(&book.path_str());
        let conn = inspect(&book.path);
        assert_eq!(user_version(&conn).unwrap(), LATEST_VERSION);
        assert_eq!(table_names(&conn), EXPECTED_TABLES);
    }

    #[test]
    fn open_book_applies_pending_migrations_to_partially_migrated_file() {
        let book = TempBook::new("partial");
        // Construct a file that stopped after migration 1 (as if an older
        // app version wrote it).
        fs::create_dir_all(book.path.parent().unwrap()).unwrap();
        {
            let conn = Connection::open(&book.path).unwrap();
            conn.execute_batch(MIGRATIONS[0].1).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }

        let _state = open_session(&book.path_str());
        let conn = inspect(&book.path);
        assert_eq!(user_version(&conn).unwrap(), LATEST_VERSION);
        assert_eq!(table_names(&conn), EXPECTED_TABLES);
    }

    #[test]
    fn open_book_enables_wal_and_foreign_keys() {
        let book = TempBook::new("pragmas");
        let state = open_session(&book.path_str());

        with_conn(&state, |conn| {
            let journal_mode: String = conn
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .unwrap();
            assert_eq!(journal_mode.to_lowercase(), "wal");
            let foreign_keys: i64 = conn
                .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .unwrap();
            assert_eq!(foreign_keys, 1, "foreign_keys should be ON");
            Ok(())
        })
        .unwrap();
    }

    // -- open_book: one-book-per-session rule ------------------------------

    #[test]
    fn open_book_same_path_twice_in_one_session_is_ok() {
        let book = TempBook::new("samepath");
        let state = open_session(&book.path_str());
        open_book_impl(&state, &book.path_str())
            .expect("re-opening the same path in one session should be a no-op success");
    }

    #[test]
    fn open_book_different_path_in_same_session_is_rejected() {
        let book = TempBook::new("first");
        let other = TempBook::new("second");
        let state = open_session(&book.path_str());

        let err = open_book_impl(&state, &other.path_str())
            .expect_err("a second book in the same session must be rejected");
        assert!(
            matches!(err, BackendError::BookAlreadyOpen { .. }),
            "expected BookAlreadyOpen, got: {err}"
        );
        assert!(!other.path.exists(), "rejected path must not be created");
    }

    #[test]
    fn open_book_relative_path_is_rejected() {
        let state = OpenBookState::new();
        let err = open_book_impl(&state, "relative/book.db")
            .expect_err("relative paths must be rejected");
        assert!(matches!(err, BackendError::PathNotAbsolute(_)));
    }

    // -- open_book: legacy plugin-era file guard ---------------------------

    /// Build a plugin-era fixture: app tables present, `user_version = 0`
    /// (the plugin tracked migrations in `_sqlx_migrations`, not
    /// user_version).
    fn build_legacy_fixture(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE payments (
                 id INTEGER PRIMARY KEY,
                 amount_cents INTEGER NOT NULL
             );
             CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY);
             INSERT INTO payments (amount_cents) VALUES (1250);",
        )
        .unwrap();
    }

    #[test]
    fn open_book_rejects_legacy_plugin_file_leaving_it_unmodified() {
        let book = TempBook::new("legacy");
        build_legacy_fixture(&book.path);
        let bytes_before = fs::read(&book.path).unwrap();

        let state = OpenBookState::new();
        let err = open_book_impl(&state, &book.path_str())
            .expect_err("legacy plugin-era file must be rejected");
        assert!(
            matches!(err, BackendError::LegacyBookFile { .. }),
            "expected LegacyBookFile, got: {err}"
        );
        let message = err.to_string();
        assert!(
            message.contains("choose a new"),
            "error should tell the user to choose a new book file, got: {message}"
        );

        let bytes_after = fs::read(&book.path).unwrap();
        assert_eq!(
            bytes_before, bytes_after,
            "rejected legacy file must be byte-identical (no migration ran)"
        );

        // The rejected book must not occupy the session slot.
        let fresh = TempBook::new("after-legacy");
        open_book_impl(&state, &fresh.path_str())
            .expect("a fresh book should still be openable after a legacy rejection");
    }

    #[test]
    fn open_book_accepts_empty_file_with_user_version_zero() {
        let book = TempBook::new("emptyfile");
        // materialize_book_file semantics: a zero-byte file already exists.
        fs::create_dir_all(book.path.parent().unwrap()).unwrap();
        fs::write(&book.path, b"").unwrap();

        let _state = open_session(&book.path_str());
        let conn = inspect(&book.path);
        assert_eq!(user_version(&conn).unwrap(), LATEST_VERSION);
    }

    // -- db_execute / db_select / param mapping ----------------------------

    #[test]
    fn execute_returns_rows_affected_and_last_insert_id() {
        let book = TempBook::new("exec");
        let state = open_session(&book.path_str());

        let first = with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Water Co")],
            )
        })
        .unwrap();
        assert_eq!(first.rows_affected, 1);
        let second = with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Power Co")],
            )
        })
        .unwrap();
        assert_eq!(second.last_insert_id, first.last_insert_id + 1);
    }

    #[test]
    fn param_types_roundtrip_through_execute_and_select() {
        let book = TempBook::new("params");
        let state = open_session(&book.path_str());

        with_conn(&state, |conn| {
            execute_impl(conn, "CREATE TABLE scratch (a, b, c, d, e)", &[])?;
            execute_impl(
                conn,
                "INSERT INTO scratch (a, b, c, d, e) VALUES (?, ?, ?, ?, ?)",
                &[json!(null), json!(4242), json!(1.5), json!("text"), json!(true)],
            )
        })
        .unwrap();

        let rows = with_conn(&state, |conn| {
            select_impl(conn, "SELECT a, b, c, d, e FROM scratch", &[])
        })
        .unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row["a"], json!(null));
        assert_eq!(row["b"], json!(4242), "integer cents stay exact integers");
        assert_eq!(row["c"], json!(1.5));
        assert_eq!(row["d"], json!("text"));
        assert_eq!(row["e"], json!(1), "bool is stored as SQLite integer 1");
    }

    #[test]
    fn unsupported_param_types_are_rejected_with_typed_error() {
        let book = TempBook::new("badparams");
        let state = open_session(&book.path_str());

        for bad in [json!([1, 2]), json!({ "k": "v" })] {
            let err = with_conn(&state, |conn| {
                execute_impl(
                    conn,
                    "INSERT INTO payees (name) VALUES (?)",
                    std::slice::from_ref(&bad),
                )
            })
            .expect_err("array/object params must be rejected");
            assert!(
                matches!(err, BackendError::UnsupportedParamType { index: 0, .. }),
                "expected UnsupportedParamType at index 0, got: {err}"
            );
        }
    }

    #[test]
    fn foreign_key_violations_surface_with_canonical_sqlite_message() {
        let book = TempBook::new("fk");
        let state = open_session(&book.path_str());

        let err = with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payments (payee_id, account_id, date, amount_cents, source)
                 VALUES (?, ?, ?, ?, ?)",
                &[json!(999), json!(999), json!("2026-01-01"), json!(1250), json!("manual")],
            )
        })
        .expect_err("dangling payee_id/account_id must violate FK constraints");
        assert!(
            err.to_string().contains("FOREIGN KEY constraint failed"),
            "TS mapSqliteError matches on the canonical text; got: {err}"
        );
    }

    #[test]
    fn no_book_open_yields_typed_error() {
        let state = OpenBookState::new();
        let err = with_conn(&state, |conn| select_impl(conn, "SELECT 1", &[]))
            .expect_err("db commands before open_book must fail");
        assert!(matches!(err, BackendError::NoBookOpen));
    }

    // -- db_batch: one real transaction ------------------------------------

    #[test]
    fn batch_commits_all_statements_and_reports_per_statement_results() {
        let book = TempBook::new("batchok");
        let state = open_session(&book.path_str());

        let statements = vec![
            BatchStatement {
                sql: "INSERT INTO payees (name) VALUES (?)".into(),
                params: vec![json!("Water Co")],
            },
            BatchStatement {
                sql: "INSERT INTO accounts (name, kind) VALUES (?, ?)".into(),
                params: vec![json!("Checking"), json!("checking")],
            },
            BatchStatement {
                sql: "INSERT INTO payments (payee_id, account_id, date, amount_cents, source)
                      VALUES (?, ?, ?, ?, ?)"
                    .into(),
                params: vec![
                    json!(1),
                    json!(1),
                    json!("2026-01-15"),
                    json!(9999),
                    json!("manual"),
                ],
            },
        ];
        let results = with_conn(&state, |conn| batch_impl(conn, &statements)).unwrap();

        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| r.rows_affected == 1));
        assert_eq!(results[0].last_insert_id, 1);
        assert_eq!(count(&state, "payees"), 1);
        assert_eq!(count(&state, "accounts"), 1);
        assert_eq!(count(&state, "payments"), 1);
    }

    #[test]
    fn batch_mid_failure_rolls_back_everything_and_names_the_statement() {
        let book = TempBook::new("batchroll");
        let state = open_session(&book.path_str());

        let payee_insert = |name: &str| BatchStatement {
            sql: "INSERT INTO payees (name) VALUES (?)".into(),
            params: vec![json!(name)],
        };
        let statements = vec![
            payee_insert("Water Co"),
            payee_insert("Power Co"),
            // Statement 3 of 5 (index 2): dangling FK — must fail.
            BatchStatement {
                sql: "INSERT INTO payments (payee_id, account_id, date, amount_cents, source)
                      VALUES (?, ?, ?, ?, ?)"
                    .into(),
                params: vec![
                    json!(999),
                    json!(999),
                    json!("2026-01-01"),
                    json!(500),
                    json!("manual"),
                ],
            },
            payee_insert("Gas Co"),
            payee_insert("Trash Co"),
        ];

        let err = with_conn(&state, |conn| batch_impl(conn, &statements))
            .expect_err("a failing statement must fail the whole batch");
        match &err {
            BackendError::BatchStatementFailed { index, message } => {
                assert_eq!(*index, 2, "error must name the failing statement index");
                assert!(
                    message.contains("FOREIGN KEY constraint failed"),
                    "error must carry the SQLite message, got: {message}"
                );
            }
            other => panic!("expected BatchStatementFailed, got: {other}"),
        }

        assert_eq!(count(&state, "payees"), 0, "rollback must undo statements 1-2");
        assert_eq!(count(&state, "payments"), 0);
    }

    #[test]
    fn batch_with_hundreds_of_statements_commits_all_rows_in_one_call() {
        let book = TempBook::new("batchbig");
        let state = open_session(&book.path_str());
        assert_eq!(count(&state, "payees"), 0, "row-count probe before the batch");

        const STATEMENT_COUNT: usize = 500;
        let statements: Vec<BatchStatement> = (0..STATEMENT_COUNT)
            .map(|i| BatchStatement {
                sql: "INSERT INTO payees (name) VALUES (?)".into(),
                params: vec![json!(format!("Payee {i}"))],
            })
            .collect();

        let results = with_conn(&state, |conn| batch_impl(conn, &statements)).unwrap();

        assert_eq!(results.len(), STATEMENT_COUNT);
        assert!(results.iter().all(|r| r.rows_affected == 1));
        // Monotonic rowids prove every statement ran once, in order, on the
        // same connection.
        for (i, result) in results.iter().enumerate() {
            assert_eq!(result.last_insert_id, results[0].last_insert_id + i as i64);
        }
        assert_eq!(
            count(&state, "payees"),
            STATEMENT_COUNT as i64,
            "row-count probe after the batch"
        );
    }

    #[test]
    fn large_batch_failure_at_statement_k_reports_index_k_and_rolls_back_all() {
        let book = TempBook::new("batchbigfail");
        let state = open_session(&book.path_str());

        const FAILING_INDEX: usize = 400;
        let mut statements: Vec<BatchStatement> = (0..FAILING_INDEX)
            .map(|i| BatchStatement {
                sql: "INSERT INTO payees (name) VALUES (?)".into(),
                params: vec![json!(format!("Payee {i}"))],
            })
            .collect();
        statements.push(BatchStatement {
            sql: "INSERT INTO no_such_table (x) VALUES (?)".into(),
            params: vec![json!(1)],
        });
        statements.push(BatchStatement {
            sql: "INSERT INTO payees (name) VALUES (?)".into(),
            params: vec![json!("after failure")],
        });

        let err = with_conn(&state, |conn| batch_impl(conn, &statements))
            .expect_err("statement 400 must fail the whole batch");
        match &err {
            BackendError::BatchStatementFailed { index, message } => {
                assert_eq!(*index, FAILING_INDEX, "error must name statement {FAILING_INDEX}");
                assert!(
                    message.contains("no such table"),
                    "error must carry the SQLite message, got: {message}"
                );
            }
            other => panic!("expected BatchStatementFailed, got: {other}"),
        }
        assert_eq!(
            count(&state, "payees"),
            0,
            "all {FAILING_INDEX} prior inserts must be rolled back"
        );
    }

    // -- concurrency: command invocations serialize on the mutex ------------

    /// The diagnosed lock-stall failure mode: with the plugin, an orphaned
    /// write lock from a phantom transaction stalled later writes. Here every
    /// invocation serializes on the state mutex over ONE connection, so
    /// concurrent writers (plain executes and batches) must all complete
    /// without deadlock and without losing a single row.
    #[test]
    fn concurrent_invocations_serialize_on_the_mutex_without_deadlock() {
        let book = TempBook::new("concurrent");
        let state = open_session(&book.path_str());

        const WRITER_THREADS: usize = 4;
        const ROWS_PER_WRITER: usize = 25;
        const BATCH_THREADS: usize = 4;
        const ROWS_PER_BATCH: usize = 25;

        std::thread::scope(|scope| {
            for t in 0..WRITER_THREADS {
                let state = &state;
                scope.spawn(move || {
                    for i in 0..ROWS_PER_WRITER {
                        with_conn(state, |conn| {
                            execute_impl(
                                conn,
                                "INSERT INTO payees (name) VALUES (?)",
                                &[json!(format!("writer-{t}-{i}"))],
                            )
                        })
                        .expect("concurrent execute should succeed");
                    }
                });
            }
            for t in 0..BATCH_THREADS {
                let state = &state;
                scope.spawn(move || {
                    let statements: Vec<BatchStatement> = (0..ROWS_PER_BATCH)
                        .map(|i| BatchStatement {
                            sql: "INSERT INTO payees (name) VALUES (?)".into(),
                            params: vec![json!(format!("batch-{t}-{i}"))],
                        })
                        .collect();
                    with_conn(state, |conn| batch_impl(conn, &statements))
                        .expect("concurrent batch should succeed");
                });
            }
            // Concurrent readers must interleave with the writers freely.
            for _ in 0..2 {
                let state = &state;
                scope.spawn(move || {
                    for _ in 0..20 {
                        with_conn(state, |conn| {
                            select_impl(conn, "SELECT COUNT(*) AS n FROM payees", &[])
                        })
                        .expect("concurrent select should succeed");
                    }
                });
            }
        });

        assert_eq!(
            count(&state, "payees"),
            (WRITER_THREADS * ROWS_PER_WRITER + BATCH_THREADS * ROWS_PER_BATCH) as i64,
            "no write may be lost or duplicated under concurrency"
        );
    }

    // -- persistence: committed batches survive a session restart -----------

    /// The diagnosed phantom-commit failure mode: the plugin reported commit
    /// success while the writes evaporated with the pooled connection. A
    /// committed batch must be readable from a brand-new session (fresh
    /// connection) on the same file.
    #[test]
    fn committed_batch_rows_persist_across_session_restart() {
        let book = TempBook::new("persist");
        {
            let state = open_session(&book.path_str());
            let statements = vec![
                BatchStatement {
                    sql: "INSERT INTO payees (name) VALUES (?)".into(),
                    params: vec![json!("Water Co")],
                },
                BatchStatement {
                    sql: "INSERT INTO accounts (name, kind) VALUES (?, ?)".into(),
                    params: vec![json!("Checking"), json!("checking")],
                },
                BatchStatement {
                    sql: "INSERT INTO payments (payee_id, account_id, date, amount_cents, source)
                          VALUES (?, ?, ?, ?, ?)"
                        .into(),
                    params: vec![
                        json!(1),
                        json!(1),
                        json!("2026-01-15"),
                        // $10,673.91 from the real workbook format, as cents.
                        json!(1_067_391),
                        json!("manual"),
                    ],
                },
            ];
            with_conn(&state, |conn| batch_impl(conn, &statements)).unwrap();
            // Dropping the state closes the only connection — app shutdown.
        }

        let state = open_session(&book.path_str());
        assert_eq!(count(&state, "payees"), 1);
        assert_eq!(count(&state, "accounts"), 1);
        assert_eq!(count(&state, "payments"), 1);
        let rows = with_conn(&state, |conn| {
            select_impl(conn, "SELECT amount_cents FROM payments", &[])
        })
        .unwrap();
        assert_eq!(
            rows[0]["amount_cents"],
            json!(1_067_391),
            "amount must survive restart as exact integer cents"
        );
    }

    #[test]
    fn batch_failure_leaves_database_content_identical() {
        let book = TempBook::new("batchbytes");
        let state = open_session(&book.path_str());
        with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Pre-existing")],
            )
        })
        .unwrap();
        let rows_before = with_conn(&state, |conn| {
            select_impl(conn, "SELECT id, name FROM payees ORDER BY id", &[])
        })
        .unwrap();

        let statements = vec![
            BatchStatement {
                sql: "INSERT INTO payees (name) VALUES (?)".into(),
                params: vec![json!("Doomed")],
            },
            BatchStatement {
                sql: "INSERT INTO no_such_table (x) VALUES (?)".into(),
                params: vec![json!(1)],
            },
        ];
        let err = with_conn(&state, |conn| batch_impl(conn, &statements))
            .expect_err("unknown table must fail the batch");
        assert!(matches!(
            err,
            BackendError::BatchStatementFailed { index: 1, .. }
        ));

        let rows_after = with_conn(&state, |conn| {
            select_impl(conn, "SELECT id, name FROM payees ORDER BY id", &[])
        })
        .unwrap();
        assert_eq!(rows_before, rows_after, "content must be unchanged after rollback");
    }
}
