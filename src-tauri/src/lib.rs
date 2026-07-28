mod db;

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

    // The plugin creates the DB file if missing, but not its parent folder.
    if let Some(parent) = book_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create book folder {}: {e}", parent.display()))?;
    }

    app.plugin(
        tauri_plugin_sql::Builder::new()
            .add_migrations(&url, db::migrations())
            .build(),
    )
    .map_err(|e| format!("failed to initialize the SQL plugin: {e}"))?;

    *slot = Some(url.clone());
    Ok(url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(RegisteredBook(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![register_book])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
