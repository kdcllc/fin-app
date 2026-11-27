mod backup;
mod db;
mod gnucash_reader;
mod report_csv;
mod report_pdf;
mod report_xlsx;
mod xlsx_reader;

use std::fs::OpenOptions;
use std::path::Path;

/// Ensure the selected book path can be opened as a SQLite file.
///
/// Creates parent folders as needed and creates the file when missing.
pub(crate) fn materialize_book_file(book_path: &Path) -> Result<(), String> {
    if let Some(parent) = book_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create book folder {}: {e}", parent.display()))?;
    }

    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(book_path)
        .map_err(|e| format!("cannot create/open book file {}: {e}", book_path.display()))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .manage(db::OpenBookState::new())
        .invoke_handler(tauri::generate_handler![
            db::open_book,
            db::db_select,
            db::db_execute,
            db::db_batch,
            db::backup_now,
            db::list_backups,
            db::restore_backup,
            xlsx_reader::read_xlsx_workbook_raw,
            report_pdf::export_report_pdf,
            report_csv::export_report_csv,
            report_xlsx::export_report_xlsx,
            gnucash_reader::gnucash_probe_book,
            gnucash_reader::gnucash_list_accounts,
            gnucash_reader::gnucash_list_transactions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::materialize_book_file;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fin-app-register-book-{nanos}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn materialize_book_file_creates_parent_and_db_file() {
        let root = unique_test_dir();
        let book_path = root.join("chosen").join("nested").join("fin-app.db");

        materialize_book_file(&book_path).expect("book file should be materialized");

        assert!(book_path.exists(), "expected db file at selected path");
        assert!(book_path.is_file(), "expected selected path to be a file");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn materialize_book_file_is_idempotent_for_existing_file() {
        let root = unique_test_dir();
        let book_path = root.join("existing").join("fin-app.db");

        materialize_book_file(&book_path).expect("first materialization should succeed");
        materialize_book_file(&book_path)
            .expect("second materialization should reopen existing file");

        assert!(book_path.exists(), "expected db file to still exist");

        let _ = fs::remove_dir_all(root);
    }
}
