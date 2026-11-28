import type { BatchStatement, Database, SqlValue } from "../db";
import type {
  AccountSubtype,
  AccountSystemRole,
  AccountType,
  LedgerAccount,
  LedgerAccountPatch,
  NewLedgerAccount,
  NewTransaction,
  ReconcileState,
  Split,
  Transaction,
  TransactionSource,
  XlsxBusinessKey,
} from "../entities";
import { EntityInUseError, ForeignKeyViolationError, ValidationError } from "../errors";
import { buildUpdate, toFlag } from "./helpers";

/** One split joined to its transaction, as the register query returns it. */
export interface RegisterSplitRow {
  split_id: number;
  transaction_id: number;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  payee_id: number | null;
  transaction_memo: string | null;
  split_memo: string | null;
  /** Signed integer cents, debit-positive. */
  amount_cents: number;
  reconcile_state: ReconcileState;
}

/** Raw (debit-positive) split sum for one account. */
export interface AccountBalanceRow {
  account_id: number;
  /** Signed integer cents, debit-positive. */
  balance_cents: number;
}

/** The xlsx identity snapshot of one `source = 'xlsx'` transaction of ANY shape. */
export interface XlsxIdentityRow {
  id: number;
  payee_id: number;
  import_account_id: number;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** Integer cents — never a float. */
  import_amount_cents: number;
  source_sheet: string;
  source_row: number;
  source_col: number;
  occurrence_index: number;
}

/** A transaction located by its `external_ref`, with whether it is payment-shaped. */
export interface TransactionRefRow {
  id: number;
  external_ref: string;
  /** Same predicate as the payments facade: payee, exactly two splits, EXPENSE + ASSET/LIABILITY. */
  payment_shaped: boolean;
}

/** 4 bound params per key; 100 keys stays far below SQLite's variable limit. */
const IDENTITY_KEY_CHUNK_SIZE = 100;
const EXTERNAL_REF_CHUNK_SIZE = 500;

export interface RegisterQuery {
  /** Inclusive ISO lower bound. Default: no lower bound. */
  from?: string;
  /** Inclusive ISO upper bound. Default: no upper bound. */
  to?: string;
}

/**
 * SQL-level ledger operations. No transaction-level domain validation lives
 * here (balance, placeholder, reconcile locks) — that is `src/core/ledger.ts`.
 * Account structure rules (parent type, subtype, cycles, system accounts) ARE
 * enforced here. Every write is one `db.batch`, so it is atomic.
 */
export interface LedgerRepo {
  /** All accounts ordered by id (placeholders and archived included). */
  listAccounts(): Promise<LedgerAccount[]>;
  /** Account by id, or `null` when unknown. */
  getAccount(id: number): Promise<LedgerAccount | null>;
  /** The account carrying a system role, or `null` when absent. */
  getSystemAccount(role: AccountSystemRole): Promise<LedgerAccount | null>;
  /**
   * Insert an account. An unknown `parent_id` raises `ForeignKeyViolationError`;
   * a `type` differing from the parent's or an invalid subtype raises `ValidationError`.
   */
  insertAccount(account: NewLedgerAccount): Promise<LedgerAccount>;
  /**
   * Apply a partial patch; returns the updated row, or `null` when `id` is unknown.
   * Enforces parent type, subtype validity, no cycles, and that system accounts
   * are not re-parented or archived (`ValidationError`).
   */
  updateAccount(id: number, patch: LedgerAccountPatch): Promise<LedgerAccount | null>;
  /** Soft-archive (additive to the task 01 contract); false when `id` is unknown; system accounts raise `ValidationError`. */
  archiveAccount(id: number): Promise<boolean>;
  /**
   * Hard delete; returns false when `id` is unknown. System accounts raise
   * `ValidationError`; an account with splits, children or payee defaults raises `EntityInUseError`.
   */
  deleteAccount(id: number): Promise<boolean>;
  /** Whether a payee id exists (additive; lets the domain raise `ForeignKeyViolationError` naming the id). */
  payeeExists(id: number): Promise<boolean>;
  /** Transaction with its splits (ordered by split id), or `null` when unknown. */
  getTransaction(id: number): Promise<Transaction | null>;
  /** Insert a transaction and its splits in one batch; returns the stored row. */
  insertTransaction(transaction: NewTransaction): Promise<Transaction>;
  /** Replace a transaction's fields and splits in one batch; `null` when `id` is unknown. */
  replaceTransaction(id: number, transaction: NewTransaction): Promise<Transaction | null>;
  /** Delete a transaction (splits cascade); returns false when `id` is unknown. */
  deleteTransaction(id: number): Promise<boolean>;
  /**
   * Additive: delete several transactions and optionally replace one (same id)
   * or insert a new one, ALL in one batch. Returns the stored replaced/inserted
   * transaction, or `null` when neither was requested.
   */
  rewriteTransactions(changes: {
    deleteIds: number[];
    replace?: { id: number; transaction: NewTransaction };
    insert?: NewTransaction;
  }): Promise<Transaction | null>;
  /**
   * Additive, read-only: every `source = 'xlsx'` transaction of ANY shape (edited
   * multi-split ones included) whose snapshot business key matches one of `keys`
   * (`account_id` ↔ `import_account_id`), ordered by id. One SELECT per chunk of
   * 100 distinct keys.
   */
  listXlsxIdentities(keys: XlsxBusinessKey[]): Promise<XlsxIdentityRow[]>;
  /**
   * Additive, read-only: every transaction of `source` whose `external_ref` is in
   * `refs`, ordered by id, with its payment-shaped flag. One SELECT per chunk of
   * 500 refs.
   */
  listTransactionsByExternalRef(
    source: TransactionSource,
    refs: string[],
  ): Promise<TransactionRefRow[]>;
  /** Splits of one account in the window, ordered by date, transaction id, split id. */
  listSplitsForAccount(accountId: number, query?: RegisterQuery): Promise<RegisterSplitRow[]>;
  /** Raw split sums per account for transactions dated on or before `asOf` (default: all dates). */
  sumSplitsByAccount(asOf?: string): Promise<AccountBalanceRow[]>;
}

interface AccountRow {
  id: number;
  name: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  parent_id: number | null;
  placeholder: 0 | 1;
  system_role: AccountSystemRole | null;
  last4: string | null;
  gnucash_guid: string | null;
  archived: 0 | 1;
}

const ACCOUNT_COLUMNS =
  "id, name, type, subtype, parent_id, placeholder, system_role, last4, gnucash_guid, archived";

function toAccount(row: AccountRow): LedgerAccount {
  return { ...row, placeholder: row.placeholder === 1, archived: row.archived === 1 };
}

interface TransactionRow {
  id: number;
  date: string;
  payee_id: number | null;
  memo: string | null;
  source: TransactionSource;
  external_ref: string | null;
  source_sheet: string | null;
  source_row: number | null;
  source_col: number | null;
  occurrence_index: number | null;
  import_account_id: number | null;
  import_amount_cents: number | null;
  created_at: string;
}

const TRANSACTION_COLUMNS =
  "id, date, payee_id, memo, source, external_ref, source_sheet, source_row, source_col, occurrence_index, import_account_id, import_amount_cents, created_at";

const SPLIT_INSERT_SQL =
  "INSERT INTO splits (transaction_id, account_id, amount_cents, memo, reconcile_state) VALUES (?, ?, ?, ?, ?)";

const VALID_SUBTYPES: Record<AccountType, readonly AccountSubtype[]> = {
  ASSET: ["bank", "cash", "savings"],
  LIABILITY: ["credit_card", "loan"],
  INCOME: [],
  EXPENSE: [],
  EQUITY: [],
};

function assertValidSubtype(type: AccountType, subtype: AccountSubtype | null): void {
  if (subtype !== null && !VALID_SUBTYPES[type].includes(subtype)) {
    throw new ValidationError(`Subtype "${subtype}" is not valid for ${type} accounts.`);
  }
}

function assertValidLast4(last4: string | null | undefined): void {
  if (last4 !== undefined && last4 !== null && !/^\d{4}$/.test(last4)) {
    throw new ValidationError("Account last4 must be exactly four digits when provided.");
  }
}

export function createLedgerRepo(db: Database): LedgerRepo {
  async function getAccount(id: number): Promise<LedgerAccount | null> {
    const rows = await db.select<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`,
      [id],
    );
    return rows.length > 0 ? toAccount(rows[0]) : null;
  }

  async function requireAccount(id: number, label: string): Promise<LedgerAccount> {
    const account = await getAccount(id);
    if (account === null) {
      throw new ForeignKeyViolationError(`${label} ${id} does not exist.`);
    }
    return account;
  }

  async function count(sql: string, params: SqlValue[]): Promise<number> {
    const rows = await db.select<{ count: number }>(sql, params);
    return rows[0]?.count ?? 0;
  }

  async function getTransaction(id: number): Promise<Transaction | null> {
    const rows = await db.select<TransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS} FROM transactions WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return null;
    const splits = await db.select<Split>(
      "SELECT id, transaction_id, account_id, amount_cents, memo, reconcile_state FROM splits WHERE transaction_id = ? ORDER BY id",
      [id],
    );
    return { ...rows[0], splits };
  }

  /**
   * Split inserts for one transaction. `transactionId` is a bound id, or `null`
   * to reference the row just inserted earlier in the same batch (same
   * connection and transaction, so it carries the highest id).
   */
  function splitStatements(
    transactionId: number | null,
    transaction: NewTransaction,
  ): BatchStatement[] {
    return transaction.splits.map((split) => ({
      sql:
        transactionId === null
          ? "INSERT INTO splits (transaction_id, account_id, amount_cents, memo, reconcile_state) VALUES ((SELECT MAX(id) FROM transactions), ?, ?, ?, ?)"
          : SPLIT_INSERT_SQL,
      params: [
        ...(transactionId === null ? [] : [transactionId]),
        split.account_id,
        split.amount_cents,
        split.memo ?? null,
        split.reconcile_state ?? "n",
      ],
    }));
  }

  function insertStatements(transaction: NewTransaction): BatchStatement[] {
    return [
      {
        sql: "INSERT INTO transactions (date, payee_id, memo, source, external_ref, source_sheet, source_row, source_col, occurrence_index, import_account_id, import_amount_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params: [
          transaction.date,
          transaction.payee_id ?? null,
          transaction.memo ?? null,
          transaction.source ?? "manual",
          transaction.external_ref ?? null,
          transaction.source_sheet ?? null,
          transaction.source_row ?? null,
          transaction.source_col ?? null,
          transaction.occurrence_index ?? null,
          transaction.import_account_id ?? null,
          transaction.import_amount_cents ?? null,
        ],
      },
      ...splitStatements(null, transaction),
    ];
  }

  function replaceStatements(id: number, transaction: NewTransaction): BatchStatement[] {
    const header = buildUpdate(
      "transactions",
      {
        date: transaction.date,
        payee_id: transaction.payee_id ?? null,
        memo: transaction.memo ?? null,
        source: transaction.source,
        external_ref: transaction.external_ref,
        source_sheet: transaction.source_sheet,
        source_row: transaction.source_row,
        source_col: transaction.source_col,
        occurrence_index: transaction.occurrence_index,
        import_account_id: transaction.import_account_id,
        import_amount_cents: transaction.import_amount_cents,
      },
      id,
    );
    if (header === null) throw new Error("replaceTransaction produced no header update.");
    return [
      header,
      { sql: "DELETE FROM splits WHERE transaction_id = ?", params: [id] },
      ...splitStatements(id, transaction),
    ];
  }

  /** True when `candidate` is `id` or one of its descendants. */
  async function isSelfOrDescendant(id: number, candidate: number): Promise<boolean> {
    let current: number | null = candidate;
    const seen = new Set<number>();
    while (current !== null && !seen.has(current)) {
      if (current === id) return true;
      seen.add(current);
      const row: LedgerAccount | null = await getAccount(current);
      current = row?.parent_id ?? null;
    }
    return false;
  }

  return {
    async listAccounts() {
      const rows = await db.select<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY id`,
      );
      return rows.map(toAccount);
    },

    getAccount,

    async getSystemAccount(role) {
      const rows = await db.select<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE system_role = ?`,
        [role],
      );
      return rows.length > 0 ? toAccount(rows[0]) : null;
    },

    async insertAccount(account) {
      if (account.name.trim().length === 0) {
        throw new ValidationError("Account name is required.");
      }
      assertValidLast4(account.last4);
      const parent = await requireAccount(account.parent_id, "Parent account");
      if (parent.type !== account.type) {
        throw new ValidationError(
          `Account type ${account.type} must match its parent's type ${parent.type}.`,
        );
      }
      const subtype = account.subtype ?? null;
      assertValidSubtype(account.type, subtype);
      const [result] = await db.batch([
        {
          sql: "INSERT INTO accounts (name, type, subtype, parent_id, placeholder, last4, gnucash_guid) VALUES (?, ?, ?, ?, ?, ?, ?)",
          params: [
            account.name,
            account.type,
            subtype,
            account.parent_id,
            account.placeholder ? 1 : 0,
            account.last4 ?? null,
            account.gnucash_guid ?? null,
          ],
        },
      ]);
      const created = await getAccount(result.lastInsertId);
      if (created === null) throw new Error("Account insert did not persist.");
      return created;
    },

    async updateAccount(id, patch) {
      const existing = await getAccount(id);
      if (existing === null) return null;
      if (patch.name !== undefined && patch.name.trim().length === 0) {
        throw new ValidationError("Account name is required.");
      }
      assertValidLast4(patch.last4);
      const isSystem = existing.system_role !== null;
      if (isSystem && patch.parent_id !== undefined && patch.parent_id !== existing.parent_id) {
        throw new ValidationError("System accounts cannot be re-parented.");
      }
      if (isSystem && patch.archived === true) {
        throw new ValidationError("System accounts cannot be archived.");
      }
      if (
        isSystem &&
        patch.placeholder !== undefined &&
        patch.placeholder !== existing.placeholder
      ) {
        throw new ValidationError("System accounts cannot change their placeholder flag.");
      }
      if (isSystem && patch.subtype !== undefined && patch.subtype !== existing.subtype) {
        throw new ValidationError("System accounts cannot change subtype.");
      }
      if (patch.parent_id !== undefined && patch.parent_id !== existing.parent_id) {
        const parent = await requireAccount(patch.parent_id, "Parent account");
        if (parent.type !== existing.type) {
          throw new ValidationError(
            `Account type ${existing.type} must match its parent's type ${parent.type}.`,
          );
        }
        if (await isSelfOrDescendant(id, patch.parent_id)) {
          throw new ValidationError("An account cannot be moved under itself or its descendants.");
        }
      }
      if (patch.subtype !== undefined) {
        assertValidSubtype(existing.type, patch.subtype);
      }
      if (patch.placeholder === true && !existing.placeholder) {
        const splitCount = await count(
          "SELECT COUNT(*) AS count FROM splits WHERE account_id = ?",
          [id],
        );
        if (splitCount > 0) {
          throw new ValidationError("An account with splits cannot become a placeholder.");
        }
      }
      const update = buildUpdate(
        "accounts",
        {
          name: patch.name,
          subtype: patch.subtype,
          parent_id: patch.parent_id,
          placeholder: toFlag(patch.placeholder),
          last4: patch.last4,
          gnucash_guid: patch.gnucash_guid,
          archived: toFlag(patch.archived),
        },
        id,
      );
      if (update !== null) await db.batch([update]);
      return getAccount(id);
    },

    async archiveAccount(id) {
      const existing = await getAccount(id);
      if (existing === null) return false;
      if (existing.system_role !== null) {
        throw new ValidationError("System accounts cannot be archived.");
      }
      await db.batch([{ sql: "UPDATE accounts SET archived = 1 WHERE id = ?", params: [id] }]);
      return true;
    },

    async deleteAccount(id) {
      const existing = await getAccount(id);
      if (existing === null) return false;
      if (existing.system_role !== null) {
        throw new ValidationError("System accounts cannot be deleted.");
      }
      const [splits, children, payees, imports] = await Promise.all([
        count("SELECT COUNT(*) AS count FROM splits WHERE account_id = ?", [id]),
        count("SELECT COUNT(*) AS count FROM accounts WHERE parent_id = ?", [id]),
        count(
          "SELECT COUNT(*) AS count FROM payees WHERE default_category_id = ? OR default_account_id = ?",
          [id, id],
        ),
        count("SELECT COUNT(*) AS count FROM transactions WHERE import_account_id = ?", [id]),
      ]);
      if (splits > 0 || children > 0 || payees > 0 || imports > 0) {
        throw new EntityInUseError(
          `Account ${id} is still referenced by splits, child accounts or payee defaults.`,
        );
      }
      await db.batch([{ sql: "DELETE FROM accounts WHERE id = ?", params: [id] }]);
      return true;
    },

    async payeeExists(id) {
      return (await count("SELECT COUNT(*) AS count FROM payees WHERE id = ?", [id])) > 0;
    },

    getTransaction,

    async insertTransaction(transaction) {
      const results = await db.batch(insertStatements(transaction));
      const stored = await getTransaction(results[0].lastInsertId);
      if (stored === null) throw new Error("Transaction insert did not persist.");
      return stored;
    },

    async replaceTransaction(id, transaction) {
      const existing = await getTransaction(id);
      if (existing === null) return null;
      await db.batch(replaceStatements(id, transaction));
      return getTransaction(id);
    },

    async rewriteTransactions({ deleteIds, replace, insert }) {
      const statements: BatchStatement[] = deleteIds.map((id) => ({
        sql: "DELETE FROM transactions WHERE id = ?",
        params: [id],
      }));
      if (replace !== undefined) {
        statements.push(...replaceStatements(replace.id, replace.transaction));
      }
      const insertIndex = statements.length;
      if (insert !== undefined) statements.push(...insertStatements(insert));
      if (statements.length === 0) return null;
      const results = await db.batch(statements);
      if (replace !== undefined) return getTransaction(replace.id);
      if (insert !== undefined) return getTransaction(results[insertIndex].lastInsertId);
      return null;
    },

    async deleteTransaction(id) {
      const [result] = await db.batch([
        { sql: "DELETE FROM transactions WHERE id = ?", params: [id] },
      ]);
      return result.rowsAffected > 0;
    },

    async listXlsxIdentities(keys) {
      const unique: XlsxBusinessKey[] = [];
      const seen = new Set<string>();
      for (const key of keys) {
        const id = `${key.payee_id}|${key.account_id}|${key.date}|${key.amount_cents}`;
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(key);
      }
      const matches: XlsxIdentityRow[] = [];
      for (let offset = 0; offset < unique.length; offset += IDENTITY_KEY_CHUNK_SIZE) {
        const chunk = unique.slice(offset, offset + IDENTITY_KEY_CHUNK_SIZE);
        const tuples = chunk.map(() => "(?, ?, ?, ?)").join(", ");
        const params: SqlValue[] = [];
        for (const key of chunk) {
          params.push(key.payee_id, key.account_id, key.date, key.amount_cents);
        }
        const rows = await db.select<XlsxIdentityRow>(
          `SELECT t.id AS id, t.payee_id AS payee_id, t.import_account_id AS import_account_id,
                  t.date AS date, t.import_amount_cents AS import_amount_cents,
                  t.source_sheet AS source_sheet, t.source_row AS source_row,
                  t.source_col AS source_col, t.occurrence_index AS occurrence_index
           FROM transactions t
           WHERE t.source = 'xlsx'
             AND (t.payee_id, t.import_account_id, t.date, t.import_amount_cents) IN (VALUES ${tuples})
           ORDER BY t.id`,
          params,
        );
        matches.push(...rows);
      }
      return matches;
    },

    async listTransactionsByExternalRef(source, refs) {
      const unique = [...new Set(refs)];
      const matches: TransactionRefRow[] = [];
      for (let offset = 0; offset < unique.length; offset += EXTERNAL_REF_CHUNK_SIZE) {
        const chunk = unique.slice(offset, offset + EXTERNAL_REF_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = await db.select<{ id: number; external_ref: string; payment_shaped: number }>(
          `SELECT t.id AS id, t.external_ref AS external_ref,
                  CASE WHEN t.payee_id IS NOT NULL
                        AND (SELECT COUNT(*) FROM splits c WHERE c.transaction_id = t.id) = 2
                        AND EXISTS (SELECT 1 FROM splits es
                                    JOIN accounts ea ON ea.id = es.account_id AND ea.type = 'EXPENSE'
                                    WHERE es.transaction_id = t.id)
                        AND EXISTS (SELECT 1 FROM splits fs
                                    JOIN accounts fa ON fa.id = fs.account_id AND fa.type IN ('ASSET', 'LIABILITY')
                                    WHERE fs.transaction_id = t.id)
                  THEN 1 ELSE 0 END AS payment_shaped
           FROM transactions t
           WHERE t.source = ? AND t.external_ref IN (${placeholders})
           ORDER BY t.id`,
          [source, ...chunk],
        );
        matches.push(
          ...rows.map((row) => ({
            id: row.id,
            external_ref: row.external_ref,
            payment_shaped: row.payment_shaped === 1,
          })),
        );
      }
      return matches;
    },

    async listSplitsForAccount(accountId, query = {}) {
      const params: SqlValue[] = [accountId];
      let where = "WHERE s.account_id = ?";
      if (query.from !== undefined) {
        where += " AND t.date >= ?";
        params.push(query.from);
      }
      if (query.to !== undefined) {
        where += " AND t.date <= ?";
        params.push(query.to);
      }
      return db.select<RegisterSplitRow>(
        `SELECT s.id AS split_id, s.transaction_id, t.date, t.payee_id, t.memo AS transaction_memo, s.memo AS split_memo, s.amount_cents, s.reconcile_state
         FROM splits s JOIN transactions t ON t.id = s.transaction_id
         ${where}
         ORDER BY t.date, t.id, s.id`,
        params,
      );
    },

    async sumSplitsByAccount(asOf) {
      const params: SqlValue[] = [];
      let where = "";
      if (asOf !== undefined) {
        where = "WHERE t.date <= ?";
        params.push(asOf);
      }
      return db.select<AccountBalanceRow>(
        `SELECT s.account_id, COALESCE(SUM(s.amount_cents), 0) AS balance_cents
         FROM splits s JOIN transactions t ON t.id = s.transaction_id
         ${where}
         GROUP BY s.account_id`,
        params,
      );
    },
  };
}
