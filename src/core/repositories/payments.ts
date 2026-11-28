import type { Database, SqlValue } from "../db";
import type {
  NewPayment,
  NewTransaction,
  Payment,
  PaymentPatch,
  XlsxBusinessKey,
} from "../entities";
import { ForeignKeyViolationError, ValidationError } from "../errors";
import { deleteTransaction, postTransaction, updateTransaction } from "../ledger";
import { createLedgerRepo, type LedgerRepo } from "./ledger";

/**
 * A payment-shaped transaction: non-NULL payee and exactly two splits — one on
 * an EXPENSE account (the category) and one on an ASSET/LIABILITY account.
 */
const PAYMENT_SELECT = `
  SELECT t.id AS id,
         t.payee_id AS payee_id,
         fs.account_id AS account_id,
         CASE WHEN ea.system_role = 'uncategorized' THEN NULL ELSE es.account_id END AS category_id,
         t.date AS date,
         es.amount_cents AS amount_cents,
         t.memo AS memo,
         t.source AS source,
         t.external_ref AS external_ref,
         t.source_sheet AS source_sheet,
         t.source_row AS source_row,
         t.source_col AS source_col,
         t.occurrence_index AS occurrence_index,
         t.created_at AS created_at
  FROM transactions t
  JOIN splits es ON es.transaction_id = t.id
  JOIN accounts ea ON ea.id = es.account_id AND ea.type = 'EXPENSE'
  JOIN splits fs ON fs.transaction_id = t.id AND fs.id != es.id
  JOIN accounts fa ON fa.id = fs.account_id AND fa.type IN ('ASSET', 'LIABILITY')
  WHERE t.payee_id IS NOT NULL
    AND (SELECT COUNT(*) FROM splits c WHERE c.transaction_id = t.id) = 2`;

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
  const value = (patch as Partial<Payment>)[key];
  return value === undefined ? current[key] : (value as Payment[K]);
}

export function createPaymentsRepo(
  db: Database,
  ledger: LedgerRepo = createLedgerRepo(db),
): PaymentsRepo {
  async function get(id: number): Promise<Payment | null> {
    const rows = await db.select<Payment>(`${PAYMENT_SELECT} AND t.id = ?`, [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  /** The EXPENSE account for a payment's category (`null` → the Uncategorized account). */
  async function categoryAccountId(categoryId: number | null | undefined): Promise<number> {
    if (categoryId === undefined || categoryId === null) {
      const uncategorized = await ledger.getSystemAccount("uncategorized");
      if (uncategorized === null)
        throw new ValidationError("The Uncategorized account is missing.");
      return uncategorized.id;
    }
    const account = await ledger.getAccount(categoryId);
    if (account === null) {
      throw new ForeignKeyViolationError(`Category ${categoryId} does not exist.`);
    }
    if (account.type !== "EXPENSE" || account.placeholder) {
      throw new ValidationError(`Account "${account.name}" is not an expense category.`);
    }
    return account.id;
  }

  async function fundingAccountId(accountId: number): Promise<number> {
    const account = await ledger.getAccount(accountId);
    if (account === null) {
      throw new ForeignKeyViolationError(`Account ${accountId} does not exist.`);
    }
    if ((account.type !== "ASSET" && account.type !== "LIABILITY") || account.placeholder) {
      throw new ValidationError(`Account "${account.name}" is not a funding account.`);
    }
    return account.id;
  }

  async function toTransaction(
    payment: Omit<Payment, "id" | "created_at">,
  ): Promise<NewTransaction> {
    const fundingId = await fundingAccountId(payment.account_id);
    const expenseId = await categoryAccountId(payment.category_id);
    const isXlsx = payment.source === "xlsx";
    return {
      date: payment.date,
      payee_id: payment.payee_id,
      memo: payment.memo,
      source: payment.source,
      external_ref: payment.external_ref,
      source_sheet: payment.source_sheet,
      source_row: payment.source_row,
      source_col: payment.source_col,
      occurrence_index: payment.occurrence_index,
      import_account_id: isXlsx ? fundingId : null,
      import_amount_cents: isXlsx ? payment.amount_cents : null,
      splits: [
        { account_id: expenseId, amount_cents: payment.amount_cents },
        { account_id: fundingId, amount_cents: -payment.amount_cents },
      ],
    };
  }

  return {
    async list(filter) {
      const clauses = ["t.date >= ?", "t.date <= ?"];
      const params: SqlValue[] = [filter.from, filter.to];
      if (filter.payeeId !== undefined) {
        clauses.push("t.payee_id = ?");
        params.push(filter.payeeId);
      }
      if (filter.accountId !== undefined) {
        clauses.push("fs.account_id = ?");
        params.push(filter.accountId);
      }
      if (filter.categoryId !== undefined) {
        clauses.push("es.account_id = ?");
        params.push(filter.categoryId);
      }
      return db.select<Payment>(
        `${PAYMENT_SELECT} AND ${clauses.join(" AND ")} ORDER BY t.date, t.id`,
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
          `${PAYMENT_SELECT}
             AND t.source = 'xlsx'
             AND (t.payee_id, t.import_account_id, t.date, t.import_amount_cents) IN (VALUES ${tuples})
           ORDER BY t.id`,
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

      const stored = await postTransaction(
        ledger,
        await toTransaction({
          payee_id: payment.payee_id,
          account_id: payment.account_id,
          category_id: payment.category_id ?? null,
          date: payment.date,
          amount_cents: payment.amount_cents,
          memo: payment.memo ?? null,
          source: payment.source,
          external_ref: payment.external_ref ?? null,
          source_sheet: payment.source_sheet ?? null,
          source_row: payment.source_row ?? null,
          source_col: payment.source_col ?? null,
          occurrence_index: payment.occurrence_index ?? null,
        }),
      );
      const created = await get(stored.id);
      if (!created) throw new Error(`payments.insert: row ${stored.id} missing`);
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

      const next = await toTransaction({
        payee_id: getPatchedField(patch, current, "payee_id"),
        account_id: getPatchedField(patch, current, "account_id"),
        category_id: getPatchedField(patch, current, "category_id") ?? null,
        date: getPatchedField(patch, current, "date"),
        amount_cents: getPatchedField(patch, current, "amount_cents"),
        memo: getPatchedField(patch, current, "memo") ?? null,
        source: getPatchedField(patch, current, "source"),
        external_ref: getPatchedField(patch, current, "external_ref") ?? null,
        source_sheet: getPatchedField(patch, current, "source_sheet") ?? null,
        source_row: getPatchedField(patch, current, "source_row") ?? null,
        source_col: getPatchedField(patch, current, "source_col") ?? null,
        occurrence_index: getPatchedField(patch, current, "occurrence_index") ?? null,
      });
      const stored = await updateTransaction(ledger, id, next);
      if (stored === null) return null;
      return get(id);
    },

    async delete(id) {
      if ((await get(id)) === null) return false;
      return deleteTransaction(ledger, id);
    },
  };
}
