import type { Database } from "../db";
import type { ImportLogEntry, NewImportLogEntry } from "../entities";
import { resolveInsertedRow } from "./insert-verify";

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
  async function get(id: number): Promise<ImportLogEntry | null> {
    const rows = await db.select<ImportLogEntry>(
      `SELECT ${COLUMNS} FROM import_log WHERE id = ?`,
      [id],
    );
    return rows.length > 0 ? rows[0] : null;
  }

  function matchesPayload(row: ImportLogEntry, entry: NewImportLogEntry): boolean {
    return (
      row.source_file === entry.source_file &&
      row.content_hash === entry.content_hash &&
      row.row_count === entry.row_count
    );
  }

  async function findByPayload(entry: NewImportLogEntry): Promise<ImportLogEntry[]> {
    return db.select<ImportLogEntry>(
      `SELECT ${COLUMNS}
       FROM import_log
       WHERE source_file = ?
         AND content_hash = ?
         AND row_count = ?
       ORDER BY id DESC
       LIMIT 2`,
      [entry.source_file, entry.content_hash, entry.row_count],
    );
  }

  return {
    async append(entry) {
      const result = await db.execute(
        "INSERT INTO import_log (source_file, content_hash, row_count) VALUES (?, ?, ?)",
        [entry.source_file, entry.content_hash, entry.row_count],
      );
      return resolveInsertedRow({
        context: "import_log.append",
        lastInsertId: result.lastInsertId,
        payload: entry,
        getById: get,
        payloadMatches: matchesPayload,
        findByPayload,
      });
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
