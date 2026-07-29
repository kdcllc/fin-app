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
  anchor_month: number;
  anchor_phase: number;
  active: 0 | 1;
}

interface RecurringSuggestionDismissalRow {
  signature: string;
  payee_id: number;
  frequency: BillFrequency;
  due_day: number;
  expected_amount_cents: number | null;
}

function toSuggestionSignature(input: {
  payee_id: number;
  frequency: BillFrequency;
  due_day: number;
  expected_amount_cents: number | null;
  anchor_month: number;
  anchor_phase: number;
}): string {
  return [
    input.payee_id,
    input.frequency,
    input.due_day,
    input.expected_amount_cents === null ? "null" : String(input.expected_amount_cents),
    input.anchor_month,
    input.anchor_phase,
  ].join("|");
}

const COLUMNS =
  "id, payee_id, frequency, expected_amount_cents, due_day, anchor_month, anchor_phase, active";

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
  /** Persist dismissal for a generated recurring-bill suggestion signature. */
  dismissSuggestion(input: {
    payee_id: number;
    frequency: BillFrequency;
    due_day: number;
    expected_amount_cents: number | null;
    anchor_month: number;
    anchor_phase: number;
  }): Promise<void>;
  /** Load persisted suggestion dismissals for deterministic filtering. */
  listSuggestionDismissals(): Promise<
    Array<{
      signature: string;
      payee_id: number;
      frequency: BillFrequency;
      due_day: number;
      expected_amount_cents: number | null;
    }>
  >;
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
        "INSERT INTO recurring_bills (payee_id, frequency, expected_amount_cents, due_day, anchor_month, anchor_phase) VALUES (?, ?, ?, ?, ?, ?)",
        [
          bill.payee_id,
          bill.frequency,
          bill.expected_amount_cents ?? null,
          bill.due_day,
          bill.anchor_month ?? 1,
          bill.anchor_phase ?? 1,
        ],
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
          anchor_month: patch.anchor_month,
          anchor_phase: patch.anchor_phase,
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

    async dismissSuggestion(input) {
      const signature = toSuggestionSignature(input);
      await db.execute(
        `INSERT OR REPLACE INTO recurring_bill_suggestion_dismissals (
           signature,
           payee_id,
           frequency,
           due_day,
           expected_amount_cents,
           dismissed_at
         ) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [
          signature,
          input.payee_id,
          input.frequency,
          input.due_day,
          input.expected_amount_cents,
        ],
      );
    },

    async listSuggestionDismissals() {
      const rows = await db.select<RecurringSuggestionDismissalRow>(
        `SELECT signature, payee_id, frequency, due_day, expected_amount_cents
         FROM recurring_bill_suggestion_dismissals`,
      );
      return rows;
    },
  };
}
