import type { Database, SqlValue } from "../db";
import type {
  NewPayment,
  Payment,
  PaymentPatch,
  XlsxDedupCheckResult,
  XlsxPaymentIdentity,
} from "../entities";
import { buildUpdate } from "./helpers";
import { resolveInsertedRow } from "./insert-verify";

const COLUMNS =
  "id, payee_id, account_id, category_id, date, amount_cents, memo, source, external_ref, source_sheet, source_row, source_col, occurrence_index, created_at";

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
   * Determine whether an xlsx-derived payment is new, an exact duplicate,
   * or a potential duplicate that needs review (business fields match but
   * source coordinates differ).
   */
  checkXlsxDedup(identity: XlsxPaymentIdentity): Promise<XlsxDedupCheckResult>;
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
  return key in patch ? (patch[key] as Payment[K]) : current[key];
}

export function createPaymentsRepo(db: Database): PaymentsRepo {
  async function get(id: number): Promise<Payment | null> {
    const rows = await db.select<Payment>(`SELECT ${COLUMNS} FROM payments WHERE id = ?`, [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  function matchesPayload(row: Payment, payment: NewPayment): boolean {
    return (
      row.payee_id === payment.payee_id &&
      row.account_id === payment.account_id &&
      row.category_id === (payment.category_id ?? null) &&
      row.date === payment.date &&
      row.amount_cents === payment.amount_cents &&
      row.memo === (payment.memo ?? null) &&
      row.source === payment.source &&
      row.external_ref === (payment.external_ref ?? null) &&
      row.source_sheet === (payment.source_sheet ?? null) &&
      row.source_row === (payment.source_row ?? null) &&
      row.source_col === (payment.source_col ?? null) &&
      row.occurrence_index === (payment.occurrence_index ?? null)
    );
  }

  async function findByPayload(payment: NewPayment): Promise<Payment[]> {
    const rows = await db.select<Payment>(
      `SELECT ${COLUMNS}
       FROM payments
       WHERE payee_id = ?
         AND account_id = ?
         AND category_id IS ?
         AND date = ?
         AND amount_cents = ?
         AND memo IS ?
         AND source = ?
         AND external_ref IS ?
         AND source_sheet IS ?
         AND source_row IS ?
         AND source_col IS ?
         AND occurrence_index IS ?
       ORDER BY id DESC
       LIMIT 2`,
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
    return rows;
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

    async checkXlsxDedup(identity) {
      const exactMatches = await db.select<Payment>(
        `SELECT ${COLUMNS}
         FROM payments
         WHERE source = 'xlsx'
           AND payee_id = ?
           AND account_id = ?
           AND date = ?
           AND amount_cents = ?
           AND source_sheet = ?
           AND source_row = ?
           AND source_col = ?
           AND occurrence_index = ?
         ORDER BY id`,
        [
          identity.payee_id,
          identity.account_id,
          identity.date,
          identity.amount_cents,
          identity.source_sheet,
          identity.source_row,
          identity.source_col,
          identity.occurrence_index,
        ],
      );
      if (exactMatches.length > 0) return { kind: "exact_duplicate", existing: exactMatches[0] };

      const potentialMatches = await db.select<Payment>(
        `SELECT ${COLUMNS}
         FROM payments
         WHERE source = 'xlsx'
           AND payee_id = ?
           AND account_id = ?
           AND date = ?
           AND amount_cents = ?
           AND (
             source_sheet != ?
             OR source_row != ?
             OR source_col != ?
             OR occurrence_index != ?
           )
         ORDER BY id`,
        [
          identity.payee_id,
          identity.account_id,
          identity.date,
          identity.amount_cents,
          identity.source_sheet,
          identity.source_row,
          identity.source_col,
          identity.occurrence_index,
        ],
      );
      if (potentialMatches.length > 0) return { kind: "potential_duplicate", matches: potentialMatches };

      return { kind: "new" };
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
      return resolveInsertedRow({
        context: "payments.insert",
        lastInsertId: result.lastInsertId,
        payload: payment,
        getById: get,
        payloadMatches: matchesPayload,
        findByPayload,
      });
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
