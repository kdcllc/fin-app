import type { Database } from "../db";
import type {
  BillFrequency,
  NewRecurringBill,
  RecurringBill,
  RecurringBillPatch,
} from "../entities";
import { buildUpdate, toFlag } from "./helpers";

interface RecurringBillRow {
  id: number;
  payee_id: number;
  frequency: BillFrequency;
  expected_amount_cents: number | null;
  due_day: number;
  active: 0 | 1;
}

const COLUMNS = "id, payee_id, frequency, expected_amount_cents, due_day, active";

function toRecurringBill(row: RecurringBillRow): RecurringBill {
  return { ...row, active: row.active === 1 };
}

export interface RecurringBillsRepo {
  /** All bills by default; pass `activeOnly` to keep only active ones. */
  list(options?: { activeOnly?: boolean }): Promise<RecurringBill[]>;
  get(id: number): Promise<RecurringBill | null>;
  /** New bills start active (schema default). */
  insert(bill: NewRecurringBill): Promise<RecurringBill>;
  /** Apply a partial patch (including `active`); null if `id` is unknown. */
  update(id: number, patch: RecurringBillPatch): Promise<RecurringBill | null>;
  /** Hard delete; returns false when `id` is unknown. */
  delete(id: number): Promise<boolean>;
}

export function createRecurringBillsRepo(db: Database): RecurringBillsRepo {
  async function get(id: number): Promise<RecurringBill | null> {
    const rows = await db.select<RecurringBillRow>(
      `SELECT ${COLUMNS} FROM recurring_bills WHERE id = ?`,
      [id],
    );
    return rows.length > 0 ? toRecurringBill(rows[0]) : null;
  }

  return {
    async list({ activeOnly = false } = {}) {
      const where = activeOnly ? " WHERE active = 1" : "";
      const rows = await db.select<RecurringBillRow>(
        `SELECT ${COLUMNS} FROM recurring_bills${where} ORDER BY due_day, id`,
      );
      return rows.map(toRecurringBill);
    },

    get,

    async insert(bill) {
      const result = await db.execute(
        "INSERT INTO recurring_bills (payee_id, frequency, expected_amount_cents, due_day) VALUES (?, ?, ?, ?)",
        [bill.payee_id, bill.frequency, bill.expected_amount_cents ?? null, bill.due_day],
      );
      const created = await get(result.lastInsertId);
      if (!created) throw new Error(`recurring_bills.insert: row ${result.lastInsertId} missing`);
      return created;
    },

    async update(id, patch) {
      const statement = buildUpdate(
        "recurring_bills",
        {
          payee_id: patch.payee_id,
          frequency: patch.frequency,
          expected_amount_cents: patch.expected_amount_cents,
          due_day: patch.due_day,
          active: toFlag(patch.active),
        },
        id,
      );
      if (statement) await db.execute(statement.sql, statement.params);
      return get(id);
    },

    async delete(id) {
      const result = await db.execute("DELETE FROM recurring_bills WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },
  };
}
