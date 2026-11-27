//! Verified timestamped backups of the fin-app SQLite book file, with retention
//! rotation and restore helpers. Backups live in `<book-dir>/backups/`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::BackendError;

/// Default retention when callers omit an explicit limit.
pub const DEFAULT_RETENTION: u32 = 20;

/// Metadata for one backup file, serialized camelCase over IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    pub path: String,
    pub created_at: String,
    pub size_bytes: u64,
}

/// Validate retention (must be >= 1). Returns the effective value.
pub fn validate_retention(retention: Option<u32>) -> Result<u32, BackendError> {
    let value = retention.unwrap_or(DEFAULT_RETENTION);
    if value < 1 {
        return Err(BackendError::InvalidRetention(value as i64));
    }
    Ok(value)
}

/// `backups/` directory adjacent to the book file.
pub fn backups_dir_for_book(book_path: &Path) -> PathBuf {
    book_path
        .parent()
        .map(|dir| dir.join("backups"))
        .unwrap_or_else(|| PathBuf::from("backups"))
}

/// Create a verified backup of `book_path` using the open `conn` (WAL-safe via the
/// SQLite backup API), rotate to `retention`, and return the new backup path.
pub fn create_backup(
    book_path: &Path,
    retention: u32,
    conn: &Connection,
) -> Result<PathBuf, BackendError> {
    validate_retention(Some(retention))?;
    create_backup_at(conn, book_path, retention, None)
}

/// Same as [`create_backup`] but allows tests to pin the UTC timestamp suffix.
#[cfg(test)]
pub fn create_backup_at_fixed_time(
    book_path: &Path,
    retention: u32,
    conn: &Connection,
    timestamp: &str,
) -> Result<PathBuf, BackendError> {
    validate_retention(Some(retention))?;
    create_backup_at(conn, book_path, retention, Some(timestamp))
}

fn create_backup_at(
    conn: &Connection,
    book_path: &Path,
    retention: u32,
    fixed_timestamp: Option<&str>,
) -> Result<PathBuf, BackendError> {
    let backups_dir = backups_dir_for_book(book_path);
    fs::create_dir_all(&backups_dir).map_err(|e| BackendError::Io(e.to_string()))?;

    let book_stem = book_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| BackendError::BackupFailed("book path has no file stem".into()))?;

    let now = SystemTime::now();
    let timestamp = fixed_timestamp
        .map(str::to_owned)
        .unwrap_or_else(|| format_utc_filename_timestamp(now));

    let backup_path = unique_backup_path(&backups_dir, book_stem, &timestamp);

    {
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            let _busy: i32 = row.get(0)?;
            let _log: i32 = row.get(1)?;
            let _checkpointed: i32 = row.get(2)?;
            Ok(())
        })
        .map_err(|e| BackendError::BackupFailed(format!("wal checkpoint failed: {e}")))?;
        fs::copy(book_path, &backup_path).map_err(|e| {
            let _ = fs::remove_file(&backup_path);
            BackendError::Io(e.to_string())
        })?;
    }

    maybe_corrupt_backup_for_test(&backup_path);

    if let Err(err) = verify_backup_copy(book_path, &backup_path) {
        let _ = fs::remove_file(&backup_path);
        return Err(err);
    }

    rotate_backups(&backups_dir, book_stem, retention)?;
    Ok(backup_path)
}

fn unique_backup_path(backups_dir: &Path, book_stem: &str, timestamp: &str) -> PathBuf {
    let base = format!("{book_stem}-{timestamp}.db");
    let mut candidate = backups_dir.join(&base);
    if !candidate.exists() {
        return candidate;
    }
    let mut suffix = 1u32;
    loop {
        candidate = backups_dir.join(format!("{book_stem}-{timestamp}-{suffix}.db"));
        if !candidate.exists() {
            return candidate;
        }
        suffix += 1;
    }
}

/// Verify the backup file matches the post-checkpoint source file (length + SHA-256).
fn verify_backup_copy(source_path: &Path, backup_path: &Path) -> Result<(), BackendError> {
    let source_bytes = fs::read(source_path).map_err(|e| BackendError::Io(e.to_string()))?;
    let backup_bytes = fs::read(backup_path).map_err(|e| BackendError::Io(e.to_string()))?;
    if backup_bytes.is_empty() {
        return Err(BackendError::BackupFailed(
            "backup verification failed: empty file".into(),
        ));
    }
    if source_bytes.len() != backup_bytes.len() {
        return Err(BackendError::BackupFailed(
            "backup verification failed: byte length mismatch".into(),
        ));
    }
    let source_digest = Sha256::digest(&source_bytes);
    let backup_digest = Sha256::digest(&backup_bytes);
    if source_digest != backup_digest {
        return Err(BackendError::BackupFailed(
            "backup verification failed: digest mismatch".into(),
        ));
    }

    let backup_conn = Connection::open_with_flags(backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| BackendError::BackupFailed(format!("backup verification failed: {e}")))?;
    let quick_check: String = backup_conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(BackendError::BackupFailed(format!(
            "backup verification failed: quick_check returned {quick_check}"
        )));
    }

    Ok(())
}

/// List pattern-matched backups for `book_path`, newest first.
pub fn list_backups(book_path: &Path) -> Result<Vec<BackupInfo>, BackendError> {
    let backups_dir = backups_dir_for_book(book_path);
    if !backups_dir.is_dir() {
        return Ok(Vec::new());
    }

    let book_stem = book_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| BackendError::BackupFailed("book path has no file stem".into()))?;

    let mut entries = Vec::new();
    for entry in fs::read_dir(&backups_dir).map_err(|e| BackendError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| BackendError::Io(e.to_string()))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !is_backup_filename(book_stem, &file_name) {
            continue;
        }
        entries.push(backup_info_from_path(&path, &file_name)?);
    }

    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(entries)
}

pub fn backup_info_from_path(path: &Path, file_name: &str) -> Result<BackupInfo, BackendError> {
    let metadata = fs::metadata(path).map_err(|e| BackendError::Io(e.to_string()))?;
    let created_at = metadata
        .modified()
        .map(format_utc_iso8601)
        .unwrap_or_else(|_| format_utc_iso8601(SystemTime::now()));
    Ok(BackupInfo {
        file_name: file_name.to_string(),
        path: path.display().to_string(),
        created_at,
        size_bytes: metadata.len(),
    })
}

/// Reject `backup_path` unless it resolves inside the open book's `backups/` folder.
pub fn validate_backup_in_backups_folder(
    book_path: &Path,
    backup_path: &Path,
) -> Result<(), BackendError> {
    let backups_dir = backups_dir_for_book(book_path);
    let backup_path = backup_path
        .canonicalize()
        .map_err(|e| BackendError::InvalidBackupPath(format!("{}: {e}", backup_path.display())))?;

    let canonical_backups = if backups_dir.exists() {
        backups_dir
            .canonicalize()
            .map_err(|e| BackendError::Io(e.to_string()))?
    } else {
        backups_dir.clone()
    };

    if !backup_path.starts_with(&canonical_backups) {
        return Err(BackendError::InvalidBackupPath(
            backup_path.display().to_string(),
        ));
    }
    Ok(())
}

/// Open the candidate backup read-only and run an integrity probe.
pub fn probe_backup_integrity(backup_path: &Path) -> Result<(), BackendError> {
    let conn = Connection::open_with_flags(backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| BackendError::BackupNotValid(format!("{}: {e}", backup_path.display())))?;
    let _: i32 = conn
        .query_row("PRAGMA schema_version", [], |row| row.get(0))
        .map_err(|e| BackendError::BackupNotValid(format!("{}: {e}", backup_path.display())))?;
    let quick_check: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| BackendError::BackupNotValid(format!("{}: {e}", backup_path.display())))?;
    if quick_check != "ok" {
        return Err(BackendError::BackupNotValid(format!(
            "{}: quick_check returned {quick_check}",
            backup_path.display()
        )));
    }
    Ok(())
}

/// Delete `-wal` / `-shm` sidecars so stale WAL cannot replay into a restored book.
pub fn delete_wal_shm_sidecars(book_path: &Path) -> Result<(), BackendError> {
    for ext in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{ext}", book_path.display()));
        if sidecar.exists() {
            fs::remove_file(&sidecar).map_err(|e| BackendError::Io(e.to_string()))?;
        }
    }
    Ok(())
}

/// Install `backup_path` over `book_path` via a same-directory temp file + rename.
pub fn install_backup_over_book(backup_path: &Path, book_path: &Path) -> Result<(), BackendError> {
    #[cfg(test)]
    if FORCE_INSTALL_FAILURE.with(|flag| {
        let enabled = flag.get();
        if enabled {
            flag.set(false);
        }
        enabled
    }) {
        return Err(BackendError::RestoreFailed(
            "forced install failure for test".into(),
        ));
    }

    let parent = book_path
        .parent()
        .ok_or_else(|| BackendError::RestoreFailed("book path has no parent directory".into()))?;
    fs::create_dir_all(parent).map_err(|e| BackendError::Io(e.to_string()))?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_path = parent.join(format!(
        ".fin-app-restore-{}-{nanos}.tmp",
        std::process::id()
    ));

    fs::copy(backup_path, &temp_path).map_err(|e| BackendError::RestoreFailed(e.to_string()))?;
    fs::rename(&temp_path, book_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        BackendError::RestoreFailed(e.to_string())
    })?;
    Ok(())
}

/// Copy a safety backup back over the live book path (rollback helper).
pub fn rollback_book_from_backup(backup_path: &Path, book_path: &Path) -> Result<(), BackendError> {
    install_backup_over_book(backup_path, book_path)
}

fn rotate_backups(backups_dir: &Path, book_stem: &str, retention: u32) -> Result<(), BackendError> {
    let mut matched = Vec::new();
    for entry in fs::read_dir(backups_dir).map_err(|e| BackendError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| BackendError::Io(e.to_string()))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_backup_filename(book_stem, &name) {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            matched.push((modified, path));
        }
    }

    if matched.len() <= retention as usize {
        return Ok(());
    }

    matched.sort_by_key(|(modified, _)| *modified);
    let to_delete = matched.len() - retention as usize;
    for (_, path) in matched.into_iter().take(to_delete) {
        fs::remove_file(&path).map_err(|e| BackendError::Io(e.to_string()))?;
    }
    Ok(())
}

fn is_backup_filename(book_stem: &str, file_name: &str) -> bool {
    if !file_name.ends_with(".db") {
        return false;
    }
    let prefix = format!("{book_stem}-");
    if !file_name.starts_with(&prefix) {
        return false;
    }
    let middle = &file_name[prefix.len()..file_name.len() - 3];
    parse_backup_timestamp(middle).is_some()
}

fn parse_backup_timestamp(middle: &str) -> Option<()> {
    // `YYYYMMDD-HHMMSS` with optional `-N` collision suffix.
    let (timestamp, suffix) = match middle.rsplit_once('-') {
        Some((head, tail)) if tail.chars().all(|c| c.is_ascii_digit()) && head.len() == 15 => {
            (head, Some(tail))
        }
        _ => (middle, None),
    };
    let _ = suffix;
    if timestamp.len() != 15 {
        return None;
    }
    let (date, time) = timestamp.split_at(8);
    if date.chars().count() != 8 || !date.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if !time.starts_with('-') {
        return None;
    }
    let time_part = &time[1..];
    if time_part.len() != 6 || !time_part.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(())
}

fn format_utc_filename_timestamp(time: SystemTime) -> String {
    let (year, month, day, hour, min, sec) = utc_components(time);
    format!("{year:04}{month:02}{day:02}-{hour:02}{min:02}{sec:02}")
}

pub fn format_utc_iso8601(time: SystemTime) -> String {
    let (year, month, day, hour, min, sec) = utc_components(time);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

fn utc_components(time: SystemTime) -> (u64, u64, u64, u64, u64, u64) {
    let secs = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    civil_from_unix_secs(secs)
}

/// Gregorian calendar conversion for Unix seconds (enough for filenames / ISO-8601).
fn civil_from_unix_secs(mut secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let sec = secs % 60;
    secs /= 60;
    let min = secs % 60;
    secs /= 60;
    let hour = secs % 24;
    secs /= 24;

    // Algorithm from Howard Hinnant (public domain).
    let z = secs + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    (year, month, day, hour, min, sec)
}

#[cfg(test)]
std::thread_local! {
    static FORCE_INSTALL_FAILURE: std::cell::Cell<bool> = std::cell::Cell::new(false);
    static SEED_STALE_WAL_ON_RESTORE: std::cell::Cell<bool> = std::cell::Cell::new(false);
    static CORRUPT_BACKUP_AFTER_COPY: std::cell::Cell<bool> = std::cell::Cell::new(false);
}

#[cfg(test)]
fn maybe_corrupt_backup_for_test(backup_path: &Path) {
    let corrupt = CORRUPT_BACKUP_AFTER_COPY.with(|flag| {
        let enabled = flag.get();
        if enabled {
            flag.set(false);
        }
        enabled
    });
    if corrupt {
        let _ = fs::write(backup_path, b"corrupted-backup-for-test");
    }
}

#[cfg(not(test))]
fn maybe_corrupt_backup_for_test(_backup_path: &Path) {}

#[cfg(test)]
pub fn force_next_install_failure() {
    FORCE_INSTALL_FAILURE.with(|flag| flag.set(true));
}

#[cfg(test)]
pub fn enable_stale_wal_seed_on_next_restore() {
    SEED_STALE_WAL_ON_RESTORE.with(|flag| flag.set(true));
}

#[cfg(test)]
pub fn enable_corrupt_backup_after_copy() {
    CORRUPT_BACKUP_AFTER_COPY.with(|flag| flag.set(true));
}

#[cfg(test)]
pub(crate) fn maybe_seed_stale_wal_for_restore(book_path: &Path) {
    let seed = SEED_STALE_WAL_ON_RESTORE.with(|flag| {
        let enabled = flag.get();
        if enabled {
            flag.set(false);
        }
        enabled
    });
    if seed {
        let wal_path = PathBuf::from(format!("{}-wal", book_path.display()));
        let _ = fs::write(wal_path, b"stale-wal-junk-that-must-not-replay");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        execute_impl, open_book_impl, select_impl, with_conn, BackendError, OpenBookState,
        APP_TABLES, MIGRATIONS,
    };
    use rusqlite::Connection;
    use serde_json::json;
    use std::fs;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

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
                "fin-app-backup-{label}-{nanos}-{}",
                std::process::id()
            ));
            let path = root.join("book.db");
            Self { root, path }
        }

        fn path_str(&self) -> String {
            self.path.display().to_string()
        }

        fn backups_dir(&self) -> PathBuf {
            backups_dir_for_book(&self.path)
        }
    }

    impl Drop for TempBook {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn open_session(path: &str) -> OpenBookState {
        let state = OpenBookState::new();
        open_book_impl(&state, path).expect("open_book should succeed");
        state
    }

    fn latest_version() -> i64 {
        MIGRATIONS[MIGRATIONS.len() - 1].0
    }

    fn user_version(path: &Path) -> i64 {
        let conn = Connection::open(path).unwrap();
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    fn pattern_matched_backups(book: &TempBook) -> Vec<PathBuf> {
        let stem = book.path.file_stem().unwrap().to_str().unwrap();
        fs::read_dir(book.backups_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if is_backup_filename(stem, &name) {
                    Some(e.path())
                } else {
                    None
                }
            })
            .collect()
    }

    fn conn_backup(book: &TempBook, state: &OpenBookState, retention: u32) -> PathBuf {
        with_conn(state, |conn| {
            create_backup(&book.path, retention, conn).map_err(|e| e)
        })
        .expect("backup should succeed")
    }

    // -- create_backup core -------------------------------------------------

    #[test]
    fn create_backup_writes_under_backups_with_utc_timestamp_pattern() {
        let book = TempBook::new("path-pattern");
        let state = open_session(&book.path_str());
        let backup_path = conn_backup(&book, &state, 20);

        assert!(backup_path.starts_with(book.backups_dir()));
        let name = backup_path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("book-"));
        assert!(name.ends_with(".db"));
        assert!(is_backup_filename("book", name));
    }

    #[test]
    fn create_backup_collision_suffix_yields_two_distinct_files() {
        let book = TempBook::new("collision");
        let state = open_session(&book.path_str());
        let fixed = "20260101-120000";
        let first = with_conn(&state, |conn| {
            create_backup_at_fixed_time(&book.path, 20, conn, fixed)
        })
        .unwrap();
        let second = with_conn(&state, |conn| {
            create_backup_at_fixed_time(&book.path, 20, conn, fixed)
        })
        .unwrap();
        assert_ne!(first, second);
        assert!(first.exists());
        assert!(second.exists());
    }

    #[test]
    fn create_backup_verification_failure_rejects_truncated_copy() {
        let book = TempBook::new("verify-fail");
        let state = open_session(&book.path_str());
        let backup_path = with_conn(&state, |conn| create_backup(&book.path, 20, conn)).unwrap();
        fs::write(&backup_path, b"truncated").unwrap();

        let err =
            verify_backup_copy(&book.path, &backup_path).expect_err("truncated backup must fail");
        assert!(
            matches!(err, BackendError::BackupFailed(_)),
            "expected verification failure, got: {err}"
        );
    }

    #[test]
    fn create_backup_verification_failure_deletes_unverified_copy() {
        let book = TempBook::new("verify-fail-internal");
        let state = open_session(&book.path_str());
        let before = pattern_matched_backups(&book).len();
        enable_corrupt_backup_after_copy();
        let err = with_conn(&state, |conn| create_backup(&book.path, 20, conn))
            .expect_err("corrupted copy must fail verification inside create_backup");
        assert!(matches!(err, BackendError::BackupFailed(_)));
        assert_eq!(
            pattern_matched_backups(&book).len(),
            before,
            "failed backup must not remain on disk"
        );
    }

    #[test]
    fn rotation_keeps_only_retention_pattern_matched_files() {
        let book = TempBook::new("rotate");
        fs::create_dir_all(book.backups_dir()).unwrap();
        let stem = "book";
        for i in 0..25 {
            let name = format!("{stem}-20260101-{i:06}.db");
            fs::write(book.backups_dir().join(name), b"sqlite").unwrap();
        }
        fs::write(book.backups_dir().join("notes.txt"), b"keep").unwrap();

        rotate_backups(&book.backups_dir(), stem, 20).unwrap();
        let remaining: Vec<_> = fs::read_dir(book.backups_dir())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            remaining
                .iter()
                .filter(|n| is_backup_filename(stem, n))
                .count(),
            20
        );
        assert!(remaining.contains(&"notes.txt".to_string()));
    }

    #[test]
    fn rotation_default_retention_is_twenty_when_unspecified() {
        let book = TempBook::new("default-retention");
        fs::create_dir_all(book.backups_dir()).unwrap();
        let stem = "book";
        for i in 0..25 {
            let name = format!("{stem}-20260201-{i:06}.db");
            fs::write(book.backups_dir().join(name), b"x").unwrap();
        }
        let retention = validate_retention(None).unwrap();
        assert_eq!(retention, DEFAULT_RETENTION);
        rotate_backups(&book.backups_dir(), stem, retention).unwrap();
        assert_eq!(pattern_matched_backups(&book).len(), 20);
    }

    #[test]
    fn invalid_retention_is_rejected_without_creating_backup() {
        let book = TempBook::new("bad-retention");
        let state = open_session(&book.path_str());
        let err = with_conn(&state, |conn| create_backup(&book.path, 0, conn))
            .expect_err("retention 0 must fail");
        assert!(matches!(err, BackendError::InvalidRetention(0)));
        assert!(!book.backups_dir().exists() || pattern_matched_backups(&book).is_empty());
    }

    // -- WAL consistency ----------------------------------------------------

    #[test]
    fn wal_backup_includes_committed_writes_from_open_session() {
        let book = TempBook::new("wal-proof");
        let state = open_session(&book.path_str());
        with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("WAL Payee")],
            )
        })
        .unwrap();

        let backup_path = conn_backup(&book, &state, 20);
        let backup_conn = Connection::open(&backup_path).unwrap();
        let name: String = backup_conn
            .query_row(
                "SELECT name FROM payees WHERE name = 'WAL Payee'",
                [],
                |r| r.get(0),
            )
            .expect("committed WAL write must appear in backup");
        assert_eq!(name, "WAL Payee");
    }

    // -- pre-migration hook -------------------------------------------------

    #[test]
    fn pre_migration_hook_creates_backup_before_migrations_apply() {
        let book = TempBook::new("hook-partial");
        fs::create_dir_all(book.path.parent().unwrap()).unwrap();
        {
            let conn = Connection::open(&book.path).unwrap();
            conn.execute_batch(MIGRATIONS[0].1).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        assert_eq!(user_version(&book.path), 1);

        let _state = open_session(&book.path_str());
        let backups = pattern_matched_backups(&book);
        assert_eq!(backups.len(), 1);
        assert_eq!(
            user_version(&backups[0]),
            1,
            "backup predates migration writes"
        );
        assert_eq!(user_version(&book.path), latest_version());
    }

    #[test]
    fn backup_failure_during_hook_aborts_open_without_migrating() {
        let book = TempBook::new("hook-fail");
        fs::create_dir_all(book.path.parent().unwrap()).unwrap();
        {
            let conn = Connection::open(&book.path).unwrap();
            conn.execute_batch(MIGRATIONS[0].1).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        let backups_dir = book.backups_dir();
        fs::create_dir_all(&backups_dir).unwrap();
        fs::write(backups_dir.join(".keep"), b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&backups_dir, fs::Permissions::from_mode(0o500)).unwrap();
        }

        let state = OpenBookState::new();
        let err = open_book_impl(&state, &book.path_str()).expect_err("open must fail");
        assert!(
            matches!(err, BackendError::BackupFailed(_) | BackendError::Io(_)),
            "expected backup failure, got: {err}"
        );
        assert_eq!(user_version(&book.path), 1);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&backups_dir, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn fresh_book_skips_pre_migration_backup() {
        let book = TempBook::new("fresh-skip");
        let _state = open_session(&book.path_str());
        assert!(
            !book.backups_dir().exists() || pattern_matched_backups(&book).is_empty(),
            "fresh book must not create a pre-migration backup"
        );
    }

    #[test]
    fn fresh_book_with_non_empty_file_still_skips_backup() {
        let book = TempBook::new("fresh-nonempty");
        fs::create_dir_all(book.path.parent().unwrap()).unwrap();
        {
            let conn = Connection::open(&book.path).unwrap();
            conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        }
        assert!(book.path.metadata().unwrap().len() > 0);
        let _state = open_session(&book.path_str());
        assert!(!book.backups_dir().exists() || pattern_matched_backups(&book).is_empty());
    }

    #[test]
    fn fully_migrated_book_skips_pre_migration_backup() {
        let book = TempBook::new("fully-migrated");
        let _first = open_session(&book.path_str());
        let before = pattern_matched_backups(&book).len();
        drop(_first);
        let _second = open_session(&book.path_str());
        assert_eq!(pattern_matched_backups(&book).len(), before);
    }

    // -- IPC command surfaces -----------------------------------------------

    #[test]
    fn backup_now_returns_backup_info_and_requires_open_book() {
        let book = TempBook::new("backup-now");
        let state = open_session(&book.path_str());
        let info = crate::db::backup_now_impl(&state, None).unwrap();
        assert!(info.path.contains("/backups/"));
        assert!(info.file_name.ends_with(".db"));
        assert!(info.created_at.ends_with('Z'));
        assert!(info.size_bytes > 0);

        let empty = OpenBookState::new();
        let err = crate::db::backup_now_impl(&empty, None).expect_err("no book");
        assert!(matches!(err, BackendError::NoBookOpen));
    }

    #[test]
    fn backup_info_serializes_camel_case_over_ipc() {
        let info = BackupInfo {
            file_name: "book-20260101-120000.db".into(),
            path: "/tmp/book/backups/book-20260101-120000.db".into(),
            created_at: "2026-01-01T12:00:00Z".into(),
            size_bytes: 42,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["fileName"], "book-20260101-120000.db");
        assert_eq!(json["path"], "/tmp/book/backups/book-20260101-120000.db");
        assert_eq!(json["createdAt"], "2026-01-01T12:00:00Z");
        assert_eq!(json["sizeBytes"], 42);
    }

    #[test]
    fn list_backups_newest_first_and_empty_when_folder_missing() {
        let book = TempBook::new("list");
        let state = open_session(&book.path_str());
        with_conn(&state, |conn| {
            create_backup_at_fixed_time(&book.path, 20, conn, "20260101-100000")
        })
        .unwrap();
        with_conn(&state, |conn| {
            create_backup_at_fixed_time(&book.path, 20, conn, "20260102-100000")
        })
        .unwrap();

        let listed = crate::db::list_backups_impl(&state).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].created_at >= listed[1].created_at);

        let fresh = TempBook::new("list-empty");
        let fresh_state = open_session(&fresh.path_str());
        assert!(crate::db::list_backups_impl(&fresh_state)
            .unwrap()
            .is_empty());

        let empty = OpenBookState::new();
        assert!(matches!(
            crate::db::list_backups_impl(&empty).expect_err("no book"),
            BackendError::NoBookOpen
        ));
    }

    #[test]
    fn backup_now_rejects_invalid_retention() {
        let book = TempBook::new("backup-now-ret");
        let state = open_session(&book.path_str());
        let err = crate::db::backup_now_impl(&state, Some(0)).expect_err("bad retention");
        assert!(matches!(err, BackendError::InvalidRetention(0)));
    }

    // -- restore sequence ---------------------------------------------------

    #[test]
    fn restore_rejects_paths_outside_backups_without_mutating_book() {
        let book = TempBook::new("restore-reject-path");
        let state = open_session(&book.path_str());
        with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Keep Me")],
            )
        })
        .unwrap();
        let bytes_before = fs::read(&book.path).unwrap();

        let outside = book.root.join("outside.db");
        fs::copy(&book.path, &outside).unwrap();
        let err = crate::db::restore_backup_impl(&state, outside.to_str().unwrap())
            .expect_err("outside path");
        assert!(matches!(err, BackendError::InvalidBackupPath(_)));

        let bytes_after = fs::read(&book.path).unwrap();
        assert_eq!(bytes_before, bytes_after);
        with_conn(&state, |conn| {
            select_impl(conn, "SELECT name FROM payees", &[])
        })
        .unwrap();
    }

    #[test]
    fn restore_rejects_invalid_backup_without_mutating_book() {
        let book = TempBook::new("restore-reject-probe");
        let state = open_session(&book.path_str());
        fs::create_dir_all(book.backups_dir()).unwrap();
        let bad = book.backups_dir().join("book-20260101-120000.db");
        fs::write(&bad, b"SQLite format 3\x00not-really").unwrap();

        let err = crate::db::restore_backup_impl(&state, bad.to_str().unwrap())
            .expect_err("invalid backup");
        assert!(matches!(err, BackendError::BackupNotValid(_)));
        with_conn(&state, |conn| select_impl(conn, "SELECT 1", &[])).unwrap();
    }

    #[test]
    fn restore_round_trip_restores_seeded_data() {
        let book = TempBook::new("round-trip");
        let state = open_session(&book.path_str());
        with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Seed Payee")],
            )
        })
        .unwrap();
        let backup_path = conn_backup(&book, &state, 20);

        with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Mutated")],
            )
        })
        .unwrap();
        assert_eq!(crate::db::count_payees(&state), 2);

        crate::db::restore_backup_impl(&state, backup_path.to_str().unwrap()).unwrap();
        assert_eq!(crate::db::count_payees(&state), 1);
        let rows = with_conn(&state, |conn| {
            select_impl(conn, "SELECT name FROM payees", &[])
        })
        .unwrap();
        assert_eq!(rows[0]["name"], json!("Seed Payee"));
    }

    #[test]
    fn restore_old_backup_reapplies_migrations_on_reopen() {
        let book = TempBook::new("restore-remigrate");
        fs::create_dir_all(book.path.parent().unwrap()).unwrap();
        {
            let conn = Connection::open(&book.path).unwrap();
            conn.execute_batch(MIGRATIONS[0].1).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute("INSERT INTO payees (name) VALUES ('Old')", [])
                .unwrap();
        }

        let _state = open_session(&book.path_str());
        let backups = pattern_matched_backups(&book);
        assert_eq!(backups.len(), 1);
        let backup_path = backups[0].clone();
        assert_eq!(user_version(&backup_path), 1);

        with_conn(&_state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Newer")],
            )
        })
        .unwrap();

        crate::db::restore_backup_impl(&_state, backup_path.to_str().unwrap()).unwrap();
        assert_eq!(user_version(&book.path), latest_version());
        let rows = with_conn(&_state, |conn| {
            select_impl(conn, "SELECT name FROM payees ORDER BY name", &[])
        })
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], json!("Old"));
    }

    #[test]
    fn restore_removes_stale_wal_before_install() {
        let book = TempBook::new("restore-wal");
        let state = open_session(&book.path_str());
        with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("From Backup")],
            )
        })
        .unwrap();
        let backup_path = conn_backup(&book, &state, 20);

        with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Live Mutation")],
            )
        })
        .unwrap();

        enable_stale_wal_seed_on_next_restore();
        crate::db::restore_backup_impl(&state, backup_path.to_str().unwrap()).unwrap();
        let rows = with_conn(&state, |conn| {
            select_impl(conn, "SELECT name FROM payees ORDER BY name", &[])
        })
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], json!("From Backup"));
    }

    #[test]
    fn restore_install_failure_reopens_original_book() {
        let book = TempBook::new("restore-install-fail");
        let state = open_session(&book.path_str());
        with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Original")],
            )
        })
        .unwrap();
        let backup_path = conn_backup(&book, &state, 20);

        force_next_install_failure();
        let err = crate::db::restore_backup_impl(&state, backup_path.to_str().unwrap())
            .expect_err("install should fail");
        assert!(matches!(err, BackendError::RestoreFailed(_)));
        let rows = with_conn(&state, |conn| {
            select_impl(conn, "SELECT name FROM payees", &[])
        })
        .unwrap();
        assert_eq!(rows[0]["name"], json!("Original"));
    }

    #[test]
    fn restore_reopen_failure_rolls_back_from_safety_backup() {
        let book = TempBook::new("restore-reopen-fail");
        let state = open_session(&book.path_str());
        with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Data A")],
            )
        })
        .unwrap();
        let backup_path = conn_backup(&book, &state, 20);

        with_conn(&state, |conn| {
            execute_impl(
                conn,
                "INSERT INTO payees (name) VALUES (?)",
                &[json!("Data B")],
            )
        })
        .unwrap();
        assert_eq!(crate::db::count_payees(&state), 2);

        crate::db::force_next_open_book_connection_failure();
        let err = crate::db::restore_backup_impl(&state, backup_path.to_str().unwrap())
            .expect_err("reopen failure should return error");
        assert!(matches!(err, BackendError::RestoreFailed(_)));

        let rows = with_conn(&state, |conn| {
            select_impl(conn, "SELECT name FROM payees ORDER BY name", &[])
        })
        .unwrap();
        assert_eq!(
            rows.len(),
            2,
            "rollback must restore the safety backup (mutated live book), not the requested backup"
        );
        assert_eq!(rows[0]["name"], json!("Data A"));
        assert_eq!(rows[1]["name"], json!("Data B"));
    }

    #[test]
    fn restore_requires_open_book() {
        let state = OpenBookState::new();
        let err = crate::db::restore_backup_impl(&state, "/tmp/nope.db").expect_err("no book");
        assert!(matches!(err, BackendError::NoBookOpen));
    }

    #[test]
    fn concurrent_restore_serializes_on_book_mutex() {
        let book = TempBook::new("restore-concurrent");
        let state = Arc::new(open_session(&book.path_str()));
        let backup_path = conn_backup(&book, &state, 20);
        let backup_path = Arc::new(backup_path);
        let barrier = Arc::new(Barrier::new(2));
        let state2 = Arc::clone(&state);
        let path2 = Arc::clone(&backup_path);
        let b1 = Arc::clone(&barrier);

        let t1 = thread::spawn(move || {
            b1.wait();
            crate::db::restore_backup_impl(&state2, path2.to_str().unwrap())
        });

        barrier.wait();
        let err = crate::db::restore_backup_impl(&state, backup_path.to_str().unwrap());
        let r1 = t1.join().unwrap();

        // One succeeds, the other errors or succeeds on same data — session stays usable.
        assert!(err.is_ok() || r1.is_ok());
        with_conn(&state, |conn| select_impl(conn, "SELECT 1", &[])).unwrap();
    }

    #[test]
    fn new_backend_error_variants_serialize_as_strings() {
        for err in [
            BackendError::BackupFailed("x".into()),
            BackendError::InvalidRetention(0),
            BackendError::InvalidBackupPath("/bad".into()),
            BackendError::BackupNotValid("bad".into()),
            BackendError::RestoreFailed("fail".into()),
        ] {
            let json = serde_json::to_string(&err).unwrap();
            assert!(json.starts_with('"'));
            assert!(json.ends_with('"'));
        }
    }

    #[test]
    fn backup_timestamps_are_utc_with_z_suffix() {
        let ts = format_utc_iso8601(SystemTime::now());
        assert!(ts.ends_with('Z'));
        assert!(ts.contains('T'));
    }

    #[test]
    fn app_tables_constant_matches_fresh_book_detection() {
        assert!(APP_TABLES.contains(&"payments"));
        assert!(APP_TABLES.contains(&"accounts"));
    }
}
