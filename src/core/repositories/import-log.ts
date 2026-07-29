import type { Database } from "../db";
import type { ImportLogEntry, NewImportLogEntry } from "../entities";

const COLUMNS = "id, source_file, content_hash, imported_at, row_count";

export interface ImportLogRepo {
  /** Append-only: record one completed import run (`imported_at` defaults in the DB). */
  append(entry: NewImportLogEntry): Promise<ImportLogEntry>;
  /** Most recent import for a workbook content hash, or null when unseen. */
  findLatestByContentHash(contentHash: string): Promise<ImportLogEntry | null>;
  /** All entries, oldest first. */
  list(): Promise<ImportLogEntry[]>;
}

export function createImportLogRepo(db: Database): ImportLogRepo {
  return {
    async append(entry) {
      const result = await db.execute(
        "INSERT INTO import_log (source_file, content_hash, row_count) VALUES (?, ?, ?)",
        [entry.source_file, entry.content_hash, entry.row_count],
      );
      const rows = await db.select<ImportLogEntry>(
        `SELECT ${COLUMNS} FROM import_log WHERE id = ?`,
        [result.lastInsertId],
      );
      if (rows.length === 0)
        throw new Error(`import_log.append: row ${result.lastInsertId} missing`);
      return rows[0];
    },

    async list() {
      return db.select<ImportLogEntry>(`SELECT ${COLUMNS} FROM import_log ORDER BY id`);
    },

      async findLatestByContentHash(contentHash) {
        const rows = await db.select<ImportLogEntry>(
          `SELECT ${COLUMNS}
           FROM import_log
           WHERE content_hash = ?
           ORDER BY id DESC
           LIMIT 1`,
          [contentHash],
        );
        return rows.length > 0 ? rows[0] : null;
      },
  };
}
