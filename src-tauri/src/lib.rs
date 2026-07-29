mod db;
mod xlsx_reader;

use std::fs::OpenOptions;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, State};

/// The `sqlite:` URL of the book registered with the SQL plugin this session,
/// if any. The plugin keys migrations by exact URL string, so registration
/// happens at runtime — once the user-chosen absolute book path is known —
/// rather than at builder time with a fixed default URL.
struct RegisteredBook(Mutex<Option<String>>);

/// Register the SQL plugin for the book at `path` (an absolute path to the
/// SQLite file) and return the `sqlite:` URL the frontend must pass to
/// `Database.load`. The plugin applies pending migrations when that URL is
/// loaded. Idempotent for the same path; switching paths requires a restart.
#[tauri::command]
fn register_book(
    app: AppHandle,
    registered: State<'_, RegisteredBook>,
    path: String,
) -> Result<String, String> {
    let book_path = PathBuf::from(&path);
    if !book_path.is_absolute() {
        return Err(format!("book path must be absolute, got: {path}"));
    }
    let url = format!("sqlite:{path}");

    let mut slot = registered.0.lock().expect("RegisteredBook mutex poisoned");
    if let Some(existing) = slot.as_deref() {
        if existing == url {
            return Ok(url);
        }
        return Err(format!(
            "a book is already registered this session ({existing}); restart the app to switch books"
        ));
    }

    // Materialize the selected book path now so first-run behavior has
    // direct, deterministic file-creation semantics.
    materialize_book_file(&book_path)?;

    app.plugin(
        tauri_plugin_sql::Builder::new()
            .add_migrations(&url, db::migrations())
            .build(),
    )
    .map_err(|e| format!("failed to initialize the SQL plugin: {e}"))?;

    *slot = Some(url.clone());
    Ok(url)
}

/// Ensure the selected book path can be opened as a SQLite file.
///
/// Creates parent folders as needed and creates the file when missing.
fn materialize_book_file(book_path: &Path) -> Result<(), String> {
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(RegisteredBook(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            register_book,
            xlsx_reader::read_xlsx_workbook_raw
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
        std::env::temp_dir().join(format!("fin-app-register-book-{nanos}-{}", std::process::id()))
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
        materialize_book_file(&book_path).expect("second materialization should reopen existing file");

        assert!(book_path.exists(), "expected db file to still exist");

        let _ = fs::remove_dir_all(root);
    }
}
