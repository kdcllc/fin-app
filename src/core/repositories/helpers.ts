import type { SqlValue } from "../db";

/**
 * Build a parameterized `UPDATE <table> SET … WHERE id = ?` statement from a
 * patch object. Keys are internal column-name literals (never user input);
 * `undefined` values mean "leave the column unchanged", `null` sets NULL.
 * Returns null when the patch has nothing to change.
 */
export function buildUpdate(
  table: string,
  columns: Record<string, SqlValue | undefined>,
  id: number,
): { sql: string; params: SqlValue[] } | null {
  const entries = Object.entries(columns).filter(([, value]) => value !== undefined) as [
    string,
    SqlValue,
  ][];
  if (entries.length === 0) return null;
  const setClause = entries.map(([column]) => `${column} = ?`).join(", ");
  return {
    sql: `UPDATE ${table} SET ${setClause} WHERE id = ?`,
    params: [...entries.map(([, value]) => value), id],
  };
}

/** Convert an optional boolean to a SQLite 0/1 flag, preserving `undefined`. */
export function toFlag(value: boolean | undefined): 0 | 1 | undefined {
  return value === undefined ? undefined : value ? 1 : 0;
}
