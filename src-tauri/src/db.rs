//! SQLite book database: versioned migrations for `tauri-plugin-sql`.
//!
//! The book file lives at a user-chosen absolute path (settings key
//! `bookPath`, picked on first run; the app config dir is offered as the
//! default). The frontend invokes the `register_book` command (`lib.rs`),
//! which registers these migrations for the book's exact `sqlite:` URL; the
//! plugin applies any pending migrations when that URL is first loaded via
//! `Database.load` in a session.
//!
//! Foreign-key enforcement: sqlx (the plugin's SQLite driver) sets
//! `PRAGMA foreign_keys = ON` on every connection by default.

use tauri_plugin_sql::{Migration, MigrationKind};

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
        Migration {
            version: 3,
            description: "import_idempotency",
            sql: include_str!("../migrations/0003_import_idempotency.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "category_archiving",
            sql: include_str!("../migrations/0004_category_archiving.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
