//! SQLite book database: connection URL + versioned migrations for
//! `tauri-plugin-sql`.
//!
//! The relative `sqlite:` URL is resolved by the plugin to a fixed default
//! dev path under the app's per-app directory (the plugin hardcodes
//! `app_config_dir`, e.g. `~/.config/com.kdcllc.finapp/fin-app.db` on
//! Linux). Task 01.4 replaces this default with a user-chosen book location.
//!
//! Foreign-key enforcement: sqlx (the plugin's SQLite driver) sets
//! `PRAGMA foreign_keys = ON` on every connection by default.

use tauri_plugin_sql::{Migration, MigrationKind};

/// Default dev book database URL, resolved under the app data directory.
pub const DB_URL: &str = "sqlite:fin-app.db";

/// All schema migrations, in order. Every future schema change is appended
/// here as a new version — never edit an already-shipped migration.
pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "schema_v1",
            sql: include_str!("../migrations/0001_schema_v1.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "prove_migration_path",
            sql: include_str!("../migrations/0002_prove_migration_path.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
