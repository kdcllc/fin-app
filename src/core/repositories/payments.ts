import type { Database, SqlValue } from "../db";
import type { NewPayment, Payment, PaymentPatch } from "../entities";
import { buildUpdate } from "./helpers";

const COLUMNS =
  "id, payee_id, account_id, category_id, date, amount_cents, memo, source, external_ref, created_at";

export interface PaymentFilter {
  /** Inclusive ISO date lower bound (`YYYY-MM-DD`). */
  from: string;
  /** Inclusive ISO date upper bound (`YYYY-MM-DD`). */
  to: string;
  payeeId?: number;
  accountId?: number;
  categoryId?: number;
}

export interface PaymentsRepo {
  /**
   * Payments in the inclusive `[from, to]` date window, optionally narrowed
   * by payee/account/category, ordered by date then id. Payments referencing
   * archived payees/accounts are always included — history stays intact.
   */
  list(filter: PaymentFilter): Promise<Payment[]>;
  get(id: number): Promise<Payment | null>;
  insert(payment: NewPayment): Promise<Payment>;
  /** Apply a partial patch; returns the updated row, or null if `id` is unknown. */
  update(id: number, patch: PaymentPatch): Promise<Payment | null>;
  /** Hard delete; returns false when `id` is unknown. */
  delete(id: number): Promise<boolean>;
}

export function createPaymentsRepo(db: Database): PaymentsRepo {
  async function get(id: number): Promise<Payment | null> {
    const rows = await db.select<Payment>(`SELECT ${COLUMNS} FROM payments WHERE id = ?`, [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  return {
    async list(filter) {
      const clauses = ["date >= ?", "date <= ?"];
      const params: SqlValue[] = [filter.from, filter.to];
      if (filter.payeeId !== undefined) {
        clauses.push("payee_id = ?");
        params.push(filter.payeeId);
      }
      if (filter.accountId !== undefined) {
        clauses.push("account_id = ?");
        params.push(filter.accountId);
      }
      if (filter.categoryId !== undefined) {
        clauses.push("category_id = ?");
        params.push(filter.categoryId);
      }
      return db.select<Payment>(
        `SELECT ${COLUMNS} FROM payments WHERE ${clauses.join(" AND ")} ORDER BY date, id`,
        params,
      );
    },

    get,

    async insert(payment) {
      const result = await db.execute(
        `INSERT INTO payments (payee_id, account_id, category_id, date, amount_cents, memo, source, external_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          payment.payee_id,
          payment.account_id,
          payment.category_id ?? null,
          payment.date,
          payment.amount_cents,
          payment.memo ?? null,
          payment.source,
          payment.external_ref ?? null,
        ],
      );
      const created = await get(result.lastInsertId);
      if (!created) throw new Error(`payments.insert: row ${result.lastInsertId} missing`);
      return created;
    },

    async update(id, patch) {
      const statement = buildUpdate(
        "payments",
        {
          payee_id: patch.payee_id,
          account_id: patch.account_id,
          category_id: patch.category_id,
          date: patch.date,
          amount_cents: patch.amount_cents,
          memo: patch.memo,
          source: patch.source,
          external_ref: patch.external_ref,
        },
        id,
      );
      if (statement) await db.execute(statement.sql, statement.params);
      return get(id);
    },

    async delete(id) {
      const result = await db.execute("DELETE FROM payments WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },
  };
}
