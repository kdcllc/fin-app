/**
 * Opening the book: the Rust `open_book` command opens (creating and
 * migrating if needed) the SQLite file at the user-chosen absolute path on
 * the app-owned single connection, then the core repositories are wired over
 * the rust-sqlite adapter.
 */
import {
  createRepositories,
  openRustSqliteDatabase,
  type Database,
  type Repositories,
} from "./core";

/** File name of the SQLite book inside the user-chosen folder. */
export const BOOK_FILE_NAME = "fin-app.db";

/** Open (creating if needed) the book at `bookPath` and wire repositories. */
export async function openBook(
  bookPath: string,
): Promise<{ db: Database; repos: Repositories }> {
  const db = await openRustSqliteDatabase(bookPath);
  return { db, repos: createRepositories(db) };
}
