import type { Database } from "../db";
import type { NewPayee, Payee, PayeePatch } from "../entities";
import { buildUpdate } from "./helpers";

interface PayeeRow {
  id: number;
  name: string;
  default_category_id: number | null;
  default_account_id: number | null;
  notes: string | null;
  archived: 0 | 1;
}

const COLUMNS = "id, name, default_category_id, default_account_id, notes, archived";

function toPayee(row: PayeeRow): Payee {
  return { ...row, archived: row.archived === 1 };
}

export interface PayeesRepo {
  /** Active payees by default; pass `includeArchived` for the full set. */
  list(options?: { includeArchived?: boolean }): Promise<Payee[]>;
  /** Fetch by id — returns archived payees too (history stays reachable). */
  get(id: number): Promise<Payee | null>;
  insert(payee: NewPayee): Promise<Payee>;
  /** Apply a partial patch; returns the updated row, or null if `id` is unknown. */
  update(id: number, patch: PayeePatch): Promise<Payee | null>;
  /** Soft-delete: hides from default lists, keeps payment history intact. */
  archive(id: number): Promise<boolean>;
}

export function createPayeesRepo(db: Database): PayeesRepo {
  async function get(id: number): Promise<Payee | null> {
    const rows = await db.select<PayeeRow>(`SELECT ${COLUMNS} FROM payees WHERE id = ?`, [id]);
    return rows.length > 0 ? toPayee(rows[0]) : null;
  }

  return {
    async list({ includeArchived = false } = {}) {
      const where = includeArchived ? "" : " WHERE archived = 0";
      const rows = await db.select<PayeeRow>(
        `SELECT ${COLUMNS} FROM payees${where} ORDER BY name, id`,
      );
      return rows.map(toPayee);
    },

    get,

    async insert(payee) {
      const result = await db.execute(
        "INSERT INTO payees (name, default_category_id, default_account_id, notes) VALUES (?, ?, ?, ?)",
        [
          payee.name,
          payee.default_category_id ?? null,
          payee.default_account_id ?? null,
          payee.notes ?? null,
        ],
      );
      const created = await get(result.lastInsertId);
      if (!created) throw new Error(`payees.insert: row ${result.lastInsertId} missing`);
      return created;
    },

    async update(id, patch) {
      const statement = buildUpdate(
        "payees",
        {
          name: patch.name,
          default_category_id: patch.default_category_id,
          default_account_id: patch.default_account_id,
          notes: patch.notes,
        },
        id,
      );
      if (statement) await db.execute(statement.sql, statement.params);
      return get(id);
    },

    async archive(id) {
      const result = await db.execute("UPDATE payees SET archived = 1 WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },
  };
}
