import type { Database, SqlValue } from "../db";
import type { NewPayment, Payment, PaymentPatch, XlsxBusinessKey } from "../entities";
import { buildUpdate } from "./helpers";

const COLUMNS =
  "id, payee_id, account_id, category_id, date, amount_cents, memo, source, external_ref, source_sheet, source_row, source_col, occurrence_index, created_at";

/** 4 bound params per key; 100 keys stays far below SQLite's variable limit. */
const BUSINESS_KEY_CHUNK_SIZE = 100;

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
  /**
   * All existing xlsx payments whose business key (payee_id, account_id,
   * date, amount_cents) matches ANY of the given tuples, ordered by id —
   * the batched lookup behind import dedup. Issues one SELECT per chunk of
   * keys (a bounded number of queries independent of caller row count);
   * duplicate tuples are collapsed before querying.
   */
  listXlsxByBusinessKeys(keys: XlsxBusinessKey[]): Promise<Payment[]>;
  get(id: number): Promise<Payment | null>;
  insert(payment: NewPayment): Promise<Payment>;
  /** Apply a partial patch; returns the updated row, or null if `id` is unknown. */
  update(id: number, patch: PaymentPatch): Promise<Payment | null>;
  /** Hard delete; returns false when `id` is unknown. */
  delete(id: number): Promise<boolean>;
}

function assertXlsxIdentity(
  payment: Pick<
    Payment,
    "source" | "source_sheet" | "source_row" | "source_col" | "occurrence_index"
  >,
): void {
  if (payment.source !== "xlsx") return;

  if (
    payment.source_sheet === null ||
    payment.source_row === null ||
    payment.source_col === null ||
    payment.occurrence_index === null
  ) {
    throw new Error("payments: xlsx source requires source coordinates and occurrence_index");
  }

  if (payment.occurrence_index < 1) {
    throw new Error("payments: xlsx occurrence_index must be >= 1");
  }
}

function getPatchedField<K extends keyof Payment>(
  patch: PaymentPatch,
  current: Payment,
  key: K,
): Payment[K] {
  if (key in patch) {
    return (patch as Partial<Payment>)[key] as Payment[K];
  }
  return current[key];
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

    async listXlsxByBusinessKeys(keys) {
      const unique: XlsxBusinessKey[] = [];
      const seen = new Set<string>();
      for (const key of keys) {
        const id = `${key.payee_id}|${key.account_id}|${key.date}|${key.amount_cents}`;
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(key);
      }

      const matches: Payment[] = [];
      for (let offset = 0; offset < unique.length; offset += BUSINESS_KEY_CHUNK_SIZE) {
        const chunk = unique.slice(offset, offset + BUSINESS_KEY_CHUNK_SIZE);
        const tuples = chunk.map(() => "(?, ?, ?, ?)").join(", ");
        const params: SqlValue[] = [];
        for (const key of chunk) {
          params.push(key.payee_id, key.account_id, key.date, key.amount_cents);
        }
        const rows = await db.select<Payment>(
          `SELECT ${COLUMNS}
           FROM payments
           WHERE source = 'xlsx'
             AND (payee_id, account_id, date, amount_cents) IN (VALUES ${tuples})
           ORDER BY id`,
          params,
        );
        matches.push(...rows);
      }
      return matches;
    },

    get,

    async insert(payment) {
      assertXlsxIdentity({
        source: payment.source,
        source_sheet: payment.source_sheet ?? null,
        source_row: payment.source_row ?? null,
        source_col: payment.source_col ?? null,
        occurrence_index: payment.occurrence_index ?? null,
      });

      const result = await db.execute(
        `INSERT INTO payments (
             payee_id,
             account_id,
             category_id,
             date,
             amount_cents,
             memo,
             source,
             external_ref,
             source_sheet,
             source_row,
             source_col,
             occurrence_index
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          payment.payee_id,
          payment.account_id,
          payment.category_id ?? null,
          payment.date,
          payment.amount_cents,
          payment.memo ?? null,
          payment.source,
          payment.external_ref ?? null,
          payment.source_sheet ?? null,
          payment.source_row ?? null,
          payment.source_col ?? null,
          payment.occurrence_index ?? null,
        ],
      );
      const created = await get(result.lastInsertId);
      if (!created) throw new Error(`payments.insert: row ${result.lastInsertId} missing`);
      return created;
    },

    async update(id, patch) {
      const current = await get(id);
      if (!current) return null;

      assertXlsxIdentity({
        source: getPatchedField(patch, current, "source"),
        source_sheet: getPatchedField(patch, current, "source_sheet"),
        source_row: getPatchedField(patch, current, "source_row"),
        source_col: getPatchedField(patch, current, "source_col"),
        occurrence_index: getPatchedField(patch, current, "occurrence_index"),
      });

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
          source_sheet: patch.source_sheet,
          source_row: patch.source_row,
          source_col: patch.source_col,
          occurrence_index: patch.occurrence_index,
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
