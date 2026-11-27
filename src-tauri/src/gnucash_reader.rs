//! Read-only GnuCash SQLite3 book access — probe, account tree, transactions.
//!
//! All opens use `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`. Never writes to
//! GnuCash files; never touches `slots` or mutates `versions`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::Serialize;

/// GnuCash 2.6–5.x SQL books carry this `versions` table value for `Gnucash-Resave`.
pub const SUPPORTED_GNUCASH_RESAVE: i64 = 19920;

const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";
const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];
const XML_PREFIX: &[u8] = b"<?xml";

// ---------------------------------------------------------------------------
// IPC payload types — JSON keys must match `src/core/gnucash-types.ts` exactly.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status")]
pub enum GnucashBookProbe {
    #[serde(rename = "ok")]
    Ok {
        #[serde(rename = "schemaVersion")]
        schema_version: i64,
    },
    #[serde(rename = "xml")]
    Xml,
    #[serde(rename = "unknown-schema")]
    UnknownSchema { detail: String },
    #[serde(rename = "missing")]
    Missing,
    #[serde(rename = "unreadable")]
    Unreadable { detail: String },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct GnucashAccount {
    pub guid: String,
    pub name: String,
    pub account_type: String,
    pub parent_guid: Option<String>,
    pub placeholder: bool,
    pub commodity_mnemonic: String,
    pub commodity_fraction: i64,
    pub full_path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct GnucashSplit {
    pub split_guid: String,
    pub account_guid: String,
    pub memo: String,
    pub value_cents: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct GnucashTransaction {
    pub txn_guid: String,
    pub post_date: String,
    pub description: String,
    pub splits: Vec<GnucashSplit>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct GnucashTransactionError {
    pub txn_guid: String,
    pub post_date: Option<String>,
    pub description: Option<String>,
    pub reason: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct GnucashTransactionList {
    pub transactions: Vec<GnucashTransaction>,
    pub errors: Vec<GnucashTransactionError>,
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

type AccountRow = (String, String, String, Option<String>, bool, String, i64);

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

fn gnucash_open_flags() -> OpenFlags {
    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
}

fn open_gnucash_readonly(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, gnucash_open_flags())
        .map_err(|e| format!("cannot open GnuCash book read-only: {e}"))
}

fn read_leading_bytes(path: &Path, n: usize) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = vec![0_u8; n];
    let read = file.read(&mut buf)?;
    buf.truncate(read);
    Ok(buf)
}

fn probe_sqlite_schema(conn: &Connection) -> GnucashBookProbe {
    let resave: Result<i64, rusqlite::Error> = conn.query_row(
        "SELECT table_version FROM versions WHERE table_name = 'Gnucash-Resave'",
        [],
        |row| row.get(0),
    );

    let resave = match resave {
        Ok(v) => v,
        Err(e) => {
            return GnucashBookProbe::Unreadable {
                detail: format!("cannot read Gnucash-Resave version: {e}"),
            };
        }
    };

    if resave != SUPPORTED_GNUCASH_RESAVE {
        return GnucashBookProbe::UnknownSchema {
            detail: resave.to_string(),
        };
    }

    let schema_version: i64 = conn
        .query_row(
            "SELECT table_version FROM versions WHERE table_name = 'Gnucash'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    GnucashBookProbe::Ok { schema_version }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn gnucash_probe_book(path: String) -> GnucashBookProbe {
    probe_book_path(&PathBuf::from(path))
}

fn probe_book_path(path: &Path) -> GnucashBookProbe {
    if !path.exists() {
        return GnucashBookProbe::Missing;
    }

    if path.is_dir() {
        return GnucashBookProbe::Unreadable {
            detail: "path is a directory, not a file".to_string(),
        };
    }

    let head = match read_leading_bytes(path, 16) {
        Ok(b) => b,
        Err(e) => {
            return GnucashBookProbe::Unreadable {
                detail: format!("cannot read file: {e}"),
            };
        }
    };

    if head.starts_with(SQLITE_MAGIC) {
        let conn = match open_gnucash_readonly(path) {
            Ok(c) => c,
            Err(detail) => return GnucashBookProbe::Unreadable { detail },
        };
        return probe_sqlite_schema(&conn);
    }

    if head.len() >= 2 && head[0] == GZIP_MAGIC[0] && head[1] == GZIP_MAGIC[1] {
        return GnucashBookProbe::Xml;
    }

    if head.starts_with(XML_PREFIX) {
        return GnucashBookProbe::Xml;
    }

    GnucashBookProbe::Unreadable {
        detail: "not a recognized GnuCash sqlite3, gzip, or XML book".to_string(),
    }
}

#[tauri::command]
pub fn gnucash_list_accounts(path: String) -> Result<Vec<GnucashAccount>, String> {
    list_accounts_path(&PathBuf::from(path))
}

fn list_accounts_path(path: &Path) -> Result<Vec<GnucashAccount>, String> {
    ensure_supported_book(path)?;
    let conn = open_gnucash_readonly(path)?;

    let root_template_guid: String = conn
        .query_row("SELECT root_template_guid FROM books LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("cannot read books table: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT a.guid, a.name, a.account_type, a.parent_guid, a.placeholder,
                    c.mnemonic, c.fraction
             FROM accounts a
             JOIN commodities c ON c.guid = a.commodity_guid",
        )
        .map_err(|e| format!("account query failed: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)? != 0,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| format!("account query failed: {e}"))?;

    let mut raw: Vec<AccountRow> = Vec::new();
    for row in rows {
        raw.push(row.map_err(|e| format!("account row failed: {e}"))?);
    }

    let excluded = template_subtree_guids(&raw, &root_template_guid);

    let name_by_guid: HashMap<String, String> = raw
        .iter()
        .map(|(g, n, ..)| (g.clone(), n.clone()))
        .collect();
    let parent_by_guid: HashMap<String, Option<String>> = raw
        .iter()
        .map(|(g, _, _, p, ..)| (g.clone(), p.clone()))
        .collect();

    let mut accounts = Vec::new();
    for (guid, name, account_type, parent_guid, placeholder, mnemonic, fraction) in raw {
        if excluded.contains(&guid) {
            continue;
        }
        let full_path = compute_full_path(&guid, &name_by_guid, &parent_by_guid);
        accounts.push(GnucashAccount {
            guid,
            name,
            account_type,
            parent_guid,
            placeholder,
            commodity_mnemonic: mnemonic,
            commodity_fraction: fraction,
            full_path,
        });
    }

    accounts.sort_by(|a, b| a.full_path.cmp(&b.full_path));
    Ok(accounts)
}

fn template_subtree_guids(accounts: &[AccountRow], root_template_guid: &str) -> HashSet<String> {
    let mut excluded = HashSet::new();
    excluded.insert(root_template_guid.to_string());

    let mut changed = true;
    while changed {
        changed = false;
        for (guid, _, _, parent, ..) in accounts {
            if excluded.contains(guid) {
                continue;
            }
            if let Some(pg) = parent {
                if excluded.contains(pg.as_str()) && excluded.insert(guid.clone()) {
                    changed = true;
                }
            }
        }
    }

    excluded
}

fn compute_full_path(
    guid: &str,
    names: &HashMap<String, String>,
    parents: &HashMap<String, Option<String>>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut current = guid.to_string();

    while let Some(name) = names.get(&current) {
        if name == "ROOT" {
            break;
        }
        parts.push(name.clone());
        match parents.get(&current).and_then(|p| p.clone()) {
            Some(parent) => current = parent,
            None => break,
        }
    }

    parts.reverse();
    parts.join(":")
}

#[tauri::command]
pub fn gnucash_list_transactions(
    path: String,
    account_guids: Vec<String>,
    from: String,
    to: String,
) -> Result<GnucashTransactionList, String> {
    list_transactions_path(&PathBuf::from(path), &account_guids, &from, &to)
}

fn list_transactions_path(
    path: &Path,
    account_guids: &[String],
    from: &str,
    to: &str,
) -> Result<GnucashTransactionList, String> {
    ensure_supported_book(path)?;
    let conn = open_gnucash_readonly(path)?;

    if account_guids.is_empty() {
        return Ok(GnucashTransactionList {
            transactions: Vec::new(),
            errors: Vec::new(),
        });
    }

    let placeholders = account_guids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "SELECT DISTINCT t.guid, t.post_date, COALESCE(t.description, '')
         FROM transactions t
         JOIN splits s ON s.tx_guid = t.guid
         WHERE s.account_guid IN ({placeholders})
         ORDER BY t.post_date, t.guid"
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("transaction query failed: {e}"))?;

    let params: Vec<&dyn rusqlite::ToSql> = account_guids
        .iter()
        .map(|g| g as &dyn rusqlite::ToSql)
        .collect();

    let txn_rows = stmt
        .query_map(params.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                read_post_date_column(row, 1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("transaction query failed: {e}"))?;

    let fraction_by_account = commodity_fractions_by_account(&conn)?;

    let mut transactions = Vec::new();
    let mut errors = Vec::new();

    for row in txn_rows {
        let (txn_guid, raw_post_date, description) =
            row.map_err(|e| format!("transaction row failed: {e}"))?;

        let post_date = match normalize_post_date(&raw_post_date) {
            Ok(d) => d,
            Err(reason) => {
                errors.push(GnucashTransactionError {
                    txn_guid,
                    post_date: Some(raw_post_date),
                    description: Some(description),
                    reason,
                });
                continue;
            }
        };

        if post_date.as_str() < from || post_date.as_str() > to {
            continue;
        }

        match load_transaction_splits(&conn, &txn_guid, &fraction_by_account) {
            Ok(splits) => {
                transactions.push(GnucashTransaction {
                    txn_guid,
                    post_date,
                    description,
                    splits,
                });
            }
            Err(reason) => {
                errors.push(GnucashTransactionError {
                    txn_guid,
                    post_date: Some(post_date),
                    description: Some(description),
                    reason,
                });
            }
        }
    }

    Ok(GnucashTransactionList {
        transactions,
        errors,
    })
}

fn ensure_supported_book(path: &Path) -> Result<(), String> {
    match probe_book_path(path) {
        GnucashBookProbe::Ok { .. } => Ok(()),
        GnucashBookProbe::Missing => Err("GnuCash book file not found".to_string()),
        GnucashBookProbe::Xml => {
            Err("book is XML format; save as sqlite3 in GnuCash (File → Save As)".to_string())
        }
        GnucashBookProbe::UnknownSchema { detail } => {
            Err(format!("unsupported GnuCash schema version: {detail}"))
        }
        GnucashBookProbe::Unreadable { detail } => {
            Err(format!("cannot read GnuCash book: {detail}"))
        }
    }
}

fn read_post_date_column(row: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<String> {
    match row.get_ref(idx)? {
        ValueRef::Text(bytes) => Ok(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Integer(n) => Ok(n.to_string()),
        other => Err(rusqlite::Error::InvalidColumnType(
            idx,
            "post_date".to_string(),
            other.data_type(),
        )),
    }
}

fn normalize_post_date(raw: &str) -> Result<String, String> {
    if raw.len() >= 8 && raw[..8].chars().all(|c| c.is_ascii_digit()) {
        let y = &raw[0..4];
        let m = &raw[4..6];
        let d = &raw[6..8];
        return Ok(format!("{y}-{m}-{d}"));
    }
    Err(format!("malformed post_date: {raw}"))
}

fn commodity_fractions_by_account(conn: &Connection) -> Result<HashMap<String, i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT a.guid, c.fraction FROM accounts a
             JOIN commodities c ON c.guid = a.commodity_guid",
        )
        .map_err(|e| format!("commodity lookup failed: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("commodity lookup failed: {e}"))?;

    let mut map = HashMap::new();
    for row in rows {
        let (guid, fraction) = row.map_err(|e| format!("commodity row failed: {e}"))?;
        map.insert(guid, fraction);
    }
    Ok(map)
}

/// Convert split `value_num`/`value_denom` to signed integer cents using commodity fraction.
fn value_to_cents(
    value_num: i64,
    value_denom: i64,
    commodity_fraction: i64,
) -> Result<i64, String> {
    if value_denom == 0 {
        return Err("split value_denom is zero".to_string());
    }

    let scaled = value_num
        .checked_mul(commodity_fraction)
        .ok_or_else(|| "value overflow during cent conversion".to_string())?;

    if scaled % value_denom != 0 {
        return Err(format!(
            "inexact rational: {value_num}/{value_denom} cannot be represented at fraction {commodity_fraction}"
        ));
    }

    Ok(scaled / value_denom)
}

fn load_transaction_splits(
    conn: &Connection,
    txn_guid: &str,
    fraction_by_account: &HashMap<String, i64>,
) -> Result<Vec<GnucashSplit>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT guid, account_guid, memo, value_num, value_denom
             FROM splits WHERE tx_guid = ?1",
        )
        .map_err(|e| format!("split query failed: {e}"))?;

    let rows = stmt
        .query_map([txn_guid], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("split query failed: {e}"))?;

    let mut splits = Vec::new();
    for row in rows {
        let (split_guid, account_guid, memo, value_num, value_denom) =
            row.map_err(|e| format!("split row failed: {e}"))?;

        if split_guid.is_empty() {
            return Err("split has empty guid".to_string());
        }

        let fraction = fraction_by_account
            .get(&account_guid)
            .copied()
            .ok_or_else(|| format!("unknown account guid on split: {account_guid}"))?;

        let value_cents = value_to_cents(value_num, value_denom, fraction)?;

        splits.push(GnucashSplit {
            split_guid,
            account_guid,
            memo,
            value_cents,
        });
    }

    if splits.len() < 2 {
        return Err(format!(
            "transaction {txn_guid} has fewer than 2 splits (malformed)"
        ));
    }

    Ok(splits)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OpenFlags;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_path(suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fin-app-gnucash-{nanos}-{}-{suffix}",
            std::process::id()
        ))
    }

    fn fixture_sql_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("gnucash")
            .join("fixture-book.sql")
    }

    fn build_temp_book() -> PathBuf {
        let book_path = unique_temp_path("book.db");
        let sql = fs::read_to_string(fixture_sql_path()).expect("fixture SQL must exist");
        {
            let conn = Connection::open(&book_path).expect("create temp book");
            conn.execute_batch(&sql).expect("apply fixture SQL");
        }
        book_path
    }

    fn file_sha256(path: &Path) -> String {
        let bytes = fs::read(path).expect("read book bytes");
        format!("{:x}", Sha256::digest(bytes))
    }

    fn probe_json(probe: &GnucashBookProbe) -> Value {
        serde_json::to_value(probe).expect("probe serializes")
    }

    // --- probe matrix ---

    #[test]
    fn gnucash_probe_sqlite_ok() {
        let book = build_temp_book();
        let probe = gnucash_probe_book(book.display().to_string());
        assert_eq!(
            probe,
            GnucashBookProbe::Ok {
                schema_version: 5_000_000
            }
        );
        let j = probe_json(&probe);
        assert_eq!(j["status"], "ok");
        assert_eq!(j["schemaVersion"], 5_000_000);
        assert!(j.get("schema_version").is_none());
        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_probe_wrong_resave() {
        let book = build_temp_book();
        {
            let conn = Connection::open(&book).expect("open for patch");
            conn.execute(
                "UPDATE versions SET table_version = 19919 WHERE table_name = 'Gnucash-Resave'",
                [],
            )
            .expect("patch resave");
        }
        let probe = gnucash_probe_book(book.display().to_string());
        assert!(matches!(
            probe,
            GnucashBookProbe::UnknownSchema { detail } if detail == "19919"
        ));
        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_probe_missing() {
        let missing = unique_temp_path("missing.db");
        let probe = gnucash_probe_book(missing.display().to_string());
        assert_eq!(probe, GnucashBookProbe::Missing);
    }

    #[test]
    fn gnucash_probe_gzip_xml() {
        let path = unique_temp_path("gzip.gnucash");
        fs::write(&path, [0x1f, 0x8b, 0x08, 0x00]).expect("write gzip magic");
        assert_eq!(
            gnucash_probe_book(path.display().to_string()),
            GnucashBookProbe::Xml
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn gnucash_probe_plain_xml() {
        let path = unique_temp_path("plain.xml");
        fs::write(&path, "<?xml version=\"1.0\"?>").expect("write xml prefix");
        assert_eq!(
            gnucash_probe_book(path.display().to_string()),
            GnucashBookProbe::Xml
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn gnucash_probe_garbage() {
        let path = unique_temp_path("garbage.bin");
        fs::write(&path, "not a gnucash book").expect("write garbage");
        let probe = gnucash_probe_book(path.display().to_string());
        assert!(matches!(probe, GnucashBookProbe::Unreadable { .. }));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn gnucash_probe_empty_file() {
        let path = unique_temp_path("empty.db");
        fs::write(&path, []).expect("write empty");
        let probe = gnucash_probe_book(path.display().to_string());
        assert!(matches!(probe, GnucashBookProbe::Unreadable { .. }));
        let _ = fs::remove_file(path);
    }

    // --- read-only ---

    #[test]
    fn gnucash_readonly_write_attempt_fails() {
        let book = build_temp_book();
        let conn = open_gnucash_readonly(&book).expect("readonly open");
        let result = conn.execute("INSERT INTO accounts (guid) VALUES ('x')", []);
        assert!(result.is_err(), "write on read-only connection must fail");
        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_readonly_book_bytes_unchanged_after_all_commands() {
        let book = build_temp_book();
        let before = file_sha256(&book);
        let path = book.display().to_string();

        let _ = gnucash_probe_book(path.clone());
        let _ = gnucash_list_accounts(path.clone());
        let _ = gnucash_list_transactions(
            path,
            vec!["a0000000000000000000000000000002".to_string()],
            "2026-01-01".to_string(),
            "2026-02-28".to_string(),
        );

        assert_eq!(before, file_sha256(&book));
        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_open_flags_are_readonly_no_mutex() {
        let flags = gnucash_open_flags();
        assert!(flags.contains(OpenFlags::SQLITE_OPEN_READ_ONLY));
        assert!(flags.contains(OpenFlags::SQLITE_OPEN_NO_MUTEX));
        assert!(!flags.contains(OpenFlags::SQLITE_OPEN_CREATE));
    }

    // --- accounts ---

    #[test]
    fn gnucash_list_accounts_tree_and_paths() {
        let book = build_temp_book();
        let accounts = gnucash_list_accounts(book.display().to_string()).expect("list accounts");

        assert!(!accounts.is_empty());

        let electric = accounts
            .iter()
            .find(|a| a.full_path == "Expenses:Utilities:Electric")
            .expect("Electric account");
        assert_eq!(electric.account_type, "EXPENSE");
        assert_eq!(electric.commodity_fraction, 100);
        assert_eq!(electric.commodity_mnemonic, "USD");

        let checking = accounts
            .iter()
            .find(|a| a.name.contains("9002"))
            .expect("Checking account");
        assert_eq!(checking.account_type, "BANK");
        assert_eq!(checking.full_path, "Assets:Checking …9002");

        let visa = accounts
            .iter()
            .find(|a| a.full_path == "Liabilities:Visa")
            .expect("Visa");
        assert_eq!(visa.account_type, "CREDIT");

        let groceries = accounts
            .iter()
            .find(|a| a.full_path == "Expenses:Groceries")
            .expect("Groceries");
        assert_eq!(groceries.account_type, "EXPENSE");

        let salary = accounts
            .iter()
            .find(|a| a.full_path == "Income:Salary")
            .expect("Salary");
        assert_eq!(salary.account_type, "INCOME");

        for acct in &accounts {
            assert!(!acct.full_path.contains("ROOT-template"));
            assert!(!acct.name.contains("Template Electric"));
        }

        let sample = &accounts[0];
        let j = serde_json::to_value(sample).expect("account json");
        for key in [
            "guid",
            "name",
            "account_type",
            "parent_guid",
            "placeholder",
            "commodity_mnemonic",
            "commodity_fraction",
            "full_path",
        ] {
            assert!(j.get(key).is_some(), "missing key {key}");
        }

        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_fixture_gnclock_empty() {
        let book = build_temp_book();
        let conn = Connection::open(&book).expect("open");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM gnclock", [], |r| r.get(0))
            .expect("count gnclock");
        assert_eq!(count, 0);
        let _ = fs::remove_file(book);
    }

    // --- transactions ---

    const CHECKING: &str = "a0000000000000000000000000000002";
    const GROCERIES: &str = "a0000000000000000000000000000008";
    const VISA: &str = "a0000000000000000000000000000004";

    #[test]
    fn gnucash_list_transactions_date_normalization() {
        let book = build_temp_book();
        let list = gnucash_list_transactions(
            book.display().to_string(),
            vec![CHECKING.to_string()],
            "2026-01-08".to_string(),
            "2026-01-08".to_string(),
        )
        .expect("list txns");

        let txn = list
            .transactions
            .iter()
            .find(|t| t.description == "Electric bill Jan")
            .expect("Jan 8 electric txn");
        assert_eq!(txn.post_date, "2026-01-08");
        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_list_transactions_windowing() {
        let book = build_temp_book();
        let jan = gnucash_list_transactions(
            book.display().to_string(),
            vec![CHECKING.to_string()],
            "2026-01-01".to_string(),
            "2026-01-31".to_string(),
        )
        .expect("jan txns");
        let feb = gnucash_list_transactions(
            book.display().to_string(),
            vec![CHECKING.to_string()],
            "2026-02-01".to_string(),
            "2026-02-28".to_string(),
        )
        .expect("feb txns");

        assert_eq!(jan.transactions.len(), 7);
        assert_eq!(feb.transactions.len(), 4);
        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_list_transactions_all_splits_pin_a() {
        let book = build_temp_book();
        let list = gnucash_list_transactions(
            book.display().to_string(),
            vec![CHECKING.to_string()],
            "2026-01-10".to_string(),
            "2026-01-10".to_string(),
        )
        .expect("list txns");

        let txn = list
            .transactions
            .iter()
            .find(|t| t.description == "Groceries Jan 10")
            .expect("groceries txn");

        assert_eq!(txn.splits.len(), 2);
        let account_guids: HashSet<_> =
            txn.splits.iter().map(|s| s.account_guid.as_str()).collect();
        assert!(account_guids.contains(CHECKING));
        assert!(account_guids.contains(GROCERIES));
        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_list_transactions_edge_amount_1067391() {
        let book = build_temp_book();
        let list = gnucash_list_transactions(
            book.display().to_string(),
            vec![VISA.to_string()],
            "2026-02-05".to_string(),
            "2026-02-05".to_string(),
        )
        .expect("list txns");

        let txn = list
            .transactions
            .iter()
            .find(|t| t.description == "Large purchase")
            .expect("large purchase");

        let visa_split = txn
            .splits
            .iter()
            .find(|s| s.account_guid == VISA)
            .expect("visa split");
        assert_eq!(visa_split.value_cents, -1_067_391);

        let grocery_split = txn
            .splits
            .iter()
            .find(|s| s.account_guid == GROCERIES)
            .expect("grocery split");
        assert_eq!(grocery_split.value_cents, 1_067_391);
        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_list_transactions_edge_amount_penny() {
        let book = build_temp_book();
        let list = gnucash_list_transactions(
            book.display().to_string(),
            vec![CHECKING.to_string()],
            "2026-01-20".to_string(),
            "2026-01-20".to_string(),
        )
        .expect("list txns");

        let txn = list
            .transactions
            .iter()
            .find(|t| t.description == "Penny purchase")
            .expect("penny txn");

        let checking_split = txn
            .splits
            .iter()
            .find(|s| s.account_guid == CHECKING)
            .expect("checking split");
        assert_eq!(checking_split.value_cents, -1);

        let grocery_split = txn
            .splits
            .iter()
            .find(|s| s.account_guid == GROCERIES)
            .expect("grocery split");
        assert_eq!(grocery_split.value_cents, 1);
        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_list_transactions_inexact_rational_in_errors() {
        let book = build_temp_book();
        let list = gnucash_list_transactions(
            book.display().to_string(),
            vec![CHECKING.to_string()],
            "2026-02-01".to_string(),
            "2026-02-28".to_string(),
        )
        .expect("list txns");

        assert!(list.transactions.len() >= 1);
        assert_eq!(list.errors.len(), 1);

        let err = &list.errors[0];
        assert_eq!(err.txn_guid, "t0000000000000000000000000000000d");
        assert_eq!(err.post_date.as_deref(), Some("2026-02-20"));
        assert_eq!(err.description.as_deref(), Some("Inexact rational txn"));
        assert!(err.reason.contains("inexact rational"));

        assert!(!list
            .transactions
            .iter()
            .any(|t| t.txn_guid == "t0000000000000000000000000000000d"));
        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_transaction_list_json_shape() {
        let book = build_temp_book();
        let list = gnucash_list_transactions(
            book.display().to_string(),
            vec![CHECKING.to_string()],
            "2026-01-08".to_string(),
            "2026-01-08".to_string(),
        )
        .expect("list txns");

        let j = serde_json::to_value(&list).expect("json");
        assert!(j.get("transactions").is_some());
        assert!(j.get("errors").is_some());

        let txn = &j["transactions"][0];
        for key in ["txn_guid", "post_date", "description", "splits"] {
            assert!(txn.get(key).is_some(), "missing {key}");
        }
        let split = &txn["splits"][0];
        for key in ["split_guid", "account_guid", "memo", "value_cents"] {
            assert!(split.get(key).is_some(), "missing split key {key}");
        }
        assert!(split["value_cents"].is_i64());

        let _ = fs::remove_file(book);
    }

    #[test]
    fn gnucash_supported_resave_constant() {
        assert_eq!(SUPPORTED_GNUCASH_RESAVE, 19920);
    }

    #[test]
    fn gnucash_value_to_cents_exact_and_inexact() {
        assert_eq!(value_to_cents(-1067391, 100, 100).unwrap(), -1067391);
        assert_eq!(value_to_cents(1, 100, 100).unwrap(), 1);
        assert!(value_to_cents(1, 3, 100).is_err());
        assert!(value_to_cents(1, 0, 100).is_err());
    }
}
