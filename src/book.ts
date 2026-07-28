/**
 * Opening the book: register its migrations with the SQL plugin (Rust
 * `register_book` command), load the database at the user-chosen absolute
 * path, and wire the core repositories. Migrations are applied by the plugin
 * when the URL is first loaded in a session.
 */
import { invoke } from "@tauri-apps/api/core";
import { createRepositories, openTauriDatabase, type Repositories } from "./core";

/** File name of the SQLite book inside the user-chosen folder. */
export const BOOK_FILE_NAME = "fin-app.db";

/** Open (creating if needed) the book at `bookPath` and wire repositories. */
export async function openBook(bookPath: string): Promise<Repositories> {
  const url = await invoke<string>("register_book", { path: bookPath });
  const db = await openTauriDatabase(url);
  return createRepositories(db);
}
