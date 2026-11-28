/**
 * Double-entry ledger domain API.
 *
 * Every function except the pure `naturalBalance` takes the `LedgerRepo` as its
 * FIRST parameter. Amounts are signed integer cents, debit-positive: a
 * transaction's splits must sum to exactly 0. Natural (display) sign: ASSET and
 * EXPENSE show the raw sum; LIABILITY, INCOME and EQUITY show its negation.
 * All SQL lives in `repositories/ledger.ts`.
 */
import type {
  AccountType,
  LedgerAccount,
  NewTransaction,
  ReconcileState,
  Transaction,
} from "./entities";
import { ForeignKeyViolationError, ValidationError } from "./errors";
import type { LedgerRepo, RegisterQuery } from "./repositories/ledger";

/** Thrown when a transaction's splits do not sum to 0. */
export class UnbalancedTransactionError extends Error {
  /** Raw split sum in integer cents (non-zero). */
  readonly imbalanceCents: number;
  constructor(imbalanceCents: number) {
    super(`transaction is unbalanced by ${imbalanceCents} cents`);
    this.name = "UnbalancedTransactionError";
    this.imbalanceCents = imbalanceCents;
  }
}

/** Thrown when an edit or delete would touch a reconciled (`y`) split. */
export class ReconciledTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciledTransactionError";
  }
}

/** Counterpart label for a multi-split (or degenerate) register row. */
export const SPLIT_COUNTERPART_LABEL = "— Split —";

/** One register line: this account's amount in a transaction plus its running balance. */
export interface RegisterRow {
  transaction: Transaction;
  transaction_id: number;
  /** First split of this account in the transaction. */
  split_id: number;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  payee_id: number | null;
  /** The transaction memo. */
  memo: string | null;
  /** This account's split amount (summed when it appears in several splits); raw, debit-positive. */
  amount_cents: number;
  /** `y` if any of this account's splits is reconciled, else `c` if any cleared, else `n`. */
  reconcile_state: ReconcileState;
  /** The other account's name when exactly one other split exists, else `"— Split —"`. */
  counterpart: string;
  /** Raw (debit-positive) account balance after this row, starting from the balance before `from`. */
  running_balance_cents: number;
}

/** An account with its raw balances, own and rolled up over its descendants. */
export interface AccountTreeNode {
  account: LedgerAccount;
  /** Raw debit-positive integer cents of this account's own splits. */
  own_balance_cents: number;
  /** Raw debit-positive integer cents including all descendants (archived ones too). */
  rolled_up_balance_cents: number;
  /** Children in name order. */
  children: AccountTreeNode[];
}

export interface AccountTreeOptions {
  /** Inclusive ISO date for balances. Default: today (local date). */
  asOf?: string;
  /** Include archived accounts. Default: `false`. Their balances roll up into parents either way. */
  includeArchived?: boolean;
}

export interface BalanceOptions {
  /** Include all descendant accounts. Default: `false`. */
  includeDescendants?: boolean;
}

export interface TransferInput {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** Account the money leaves (credited, `−amount`). */
  fromAccountId: number;
  /** Account the money enters (debited, `+amount`). */
  toAccountId: number;
  /** Positive integer cents. */
  amount_cents: number;
  /** Default `null`. */
  memo?: string | null;
  /** Default `null`. */
  payee_id?: number | null;
}

export interface IncomeInput {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** INCOME account the money is attributed to (`−amount`). */
  incomeAccountId: number;
  /** ASSET or LIABILITY account that receives the money (`+amount`). */
  depositAccountId: number;
  /** Positive integer cents. */
  amount_cents: number;
  /** Default `null`. */
  memo?: string | null;
  /** Default `null`. */
  payee_id?: number | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertIsoDate(date: string, label = "date"): void {
  const match = typeof date === "string" ? ISO_DATE.exec(date) : null;
  if (match === null) {
    throw new ValidationError(`${label} must be an ISO date (YYYY-MM-DD).`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new ValidationError(`${label} ${date} is not a real calendar date.`);
  }
}

function localToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function assertPositiveCents(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ValidationError("amount_cents must be a positive integer number of cents.");
  }
}

/** True for the account types that can fund a payment (hold money or debt). */
function isFundingType(type: AccountType): boolean {
  return type === "ASSET" || type === "LIABILITY";
}

/**
 * Pure validation of everything that needs no database: split count, integer
 * amounts, balance, date. Throws before any read or write happens.
 */
function validateShape(input: NewTransaction): void {
  assertIsoDate(input.date);
  if (!Array.isArray(input.splits) || input.splits.length < 2) {
    throw new ValidationError("A transaction needs at least two splits.");
  }
  let sum = 0;
  for (const split of input.splits) {
    if (!Number.isSafeInteger(split.amount_cents)) {
      throw new ValidationError("Every split amount_cents must be a safe integer.");
    }
    sum += split.amount_cents;
  }
  if (!Number.isSafeInteger(sum)) {
    throw new ValidationError("Split amounts overflow the safe integer range.");
  }
  if (sum !== 0) throw new UnbalancedTransactionError(sum);
}

/**
 * Validate references: accounts exist and are not placeholders (archived are
 * fine), payee exists. Returns the accounts by id.
 */
async function validateReferences(
  ledger: LedgerRepo,
  input: NewTransaction,
): Promise<Map<number, LedgerAccount>> {
  const accounts = new Map<number, LedgerAccount>();
  for (const split of input.splits) {
    if (accounts.has(split.account_id)) continue;
    const account = await ledger.getAccount(split.account_id);
    if (account === null) {
      throw new ForeignKeyViolationError(`Account ${split.account_id} does not exist.`);
    }
    if (account.placeholder) {
      throw new ValidationError(
        `Account "${account.name}" is a placeholder and cannot hold splits.`,
      );
    }
    accounts.set(split.account_id, account);
  }
  if (input.payee_id !== undefined && input.payee_id !== null) {
    if (!(await ledger.payeeExists(input.payee_id))) {
      throw new ForeignKeyViolationError(`Payee ${input.payee_id} does not exist.`);
    }
  }
  return accounts;
}

/**
 * When the post-write shape is a payment (non-null payee, one EXPENSE split and
 * one ASSET/LIABILITY split), return the xlsx identity snapshot for it.
 */
function paymentSnapshot(
  input: NewTransaction,
  accounts: Map<number, LedgerAccount>,
): { import_account_id: number; import_amount_cents: number } | null {
  if (input.payee_id === undefined || input.payee_id === null || input.splits.length !== 2) {
    return null;
  }
  const types = input.splits.map((split) => accounts.get(split.account_id)?.type);
  const expenseIndex = types.indexOf("EXPENSE");
  if (expenseIndex === -1) return null;
  const funding = input.splits[1 - expenseIndex];
  const fundingType = types[1 - expenseIndex];
  if (fundingType === undefined || !isFundingType(fundingType)) return null;
  return {
    import_account_id: funding.account_id,
    import_amount_cents: input.splits[expenseIndex].amount_cents,
  };
}

function assertNotReconciled(transaction: Transaction, verb: string): void {
  if (transaction.splits.some((split) => split.reconcile_state === "y")) {
    throw new ReconciledTransactionError(
      `Transaction ${transaction.id} has a reconciled split and cannot be ${verb}.`,
    );
  }
}

/**
 * Validate and insert a transaction atomically (one batch).
 * @param ledger repository to write through
 * @param input transaction fields and splits (splits must sum to 0; `source` defaults to `"manual"`)
 * @throws UnbalancedTransactionError when the splits do not sum to 0
 * @throws ValidationError for < 2 splits, non-integer amounts, a bad date or a placeholder account
 * @throws ForeignKeyViolationError for an unknown account or payee id
 */
export async function postTransaction(
  ledger: LedgerRepo,
  input: NewTransaction,
): Promise<Transaction> {
  validateShape(input);
  const accounts = await validateReferences(ledger, input);
  let toStore = input;
  if (
    input.source === "xlsx" &&
    (input.import_account_id == null || input.import_amount_cents == null)
  ) {
    const snapshot = paymentSnapshot(input, accounts);
    if (snapshot !== null) toStore = { ...input, ...snapshot };
  }
  return ledger.insertTransaction(toStore);
}

/**
 * Replace a transaction's fields and splits atomically (one batch).
 * xlsx provenance columns (and `source`, `external_ref`) are preserved unless
 * `input` supplies them; an xlsx transaction that is still payment-shaped gets
 * its import snapshot refreshed from the new splits.
 * @param ledger repository to write through
 * @param id transaction id
 * @param input replacement fields and splits (must sum to 0)
 * @returns the stored transaction, or `null` for an unknown id
 * @throws ReconciledTransactionError when an existing split is reconciled (`y`)
 * @throws UnbalancedTransactionError when the splits do not sum to 0
 */
export async function updateTransaction(
  ledger: LedgerRepo,
  id: number,
  input: NewTransaction,
): Promise<Transaction | null> {
  validateShape(input);
  const accounts = await validateReferences(ledger, input);
  const existing = await ledger.getTransaction(id);
  if (existing === null) return null;
  assertNotReconciled(existing, "edited");
  let toStore = input;
  if ((input.source ?? existing.source) === "xlsx") {
    const snapshot = paymentSnapshot(input, accounts);
    if (snapshot !== null) toStore = { ...input, ...snapshot };
  } else {
    toStore = { ...input, import_account_id: null, import_amount_cents: null };
  }
  return ledger.replaceTransaction(id, toStore);
}

/**
 * Delete a transaction and its splits atomically.
 * @param ledger repository to write through
 * @param id transaction id
 * @returns `false` for an unknown id
 * @throws ReconciledTransactionError when a split is reconciled (`y`)
 */
export async function deleteTransaction(ledger: LedgerRepo, id: number): Promise<boolean> {
  const existing = await ledger.getTransaction(id);
  if (existing === null) return false;
  assertNotReconciled(existing, "deleted");
  return ledger.deleteTransaction(id);
}

/** A transaction with its splits, or `null` when unknown. */
export async function getTransaction(ledger: LedgerRepo, id: number): Promise<Transaction | null> {
  return ledger.getTransaction(id);
}

/** Sum raw balances of `accountId` (and optionally its descendants). */
function sumWithin(
  accounts: LedgerAccount[],
  balances: Map<number, number>,
  rootId: number,
  includeDescendants: boolean,
): number {
  if (!includeDescendants) return balances.get(rootId) ?? 0;
  const childrenOf = new Map<number, number[]>();
  for (const account of accounts) {
    if (account.parent_id === null) continue;
    const list = childrenOf.get(account.parent_id) ?? [];
    list.push(account.id);
    childrenOf.set(account.parent_id, list);
  }
  let total = 0;
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    total += balances.get(current) ?? 0;
    stack.push(...(childrenOf.get(current) ?? []));
  }
  return total;
}

/**
 * Raw (debit-positive) balance of an account on a date.
 * @param ledger repository to read through
 * @param accountId account id
 * @param asOf inclusive ISO date
 * @param options `includeDescendants` (default `false`)
 * @returns integer cents; apply `naturalBalance` for display sign
 * @throws ForeignKeyViolationError for an unknown account
 */
export async function balanceAsOf(
  ledger: LedgerRepo,
  accountId: number,
  asOf: string,
  { includeDescendants = false }: BalanceOptions = {},
): Promise<number> {
  assertIsoDate(asOf, "asOf");
  if ((await ledger.getAccount(accountId)) === null) {
    throw new ForeignKeyViolationError(`Account ${accountId} does not exist.`);
  }
  const sums = await ledger.sumSplitsByAccount(asOf);
  const balances = new Map(sums.map((row) => [row.account_id, row.balance_cents]));
  if (!includeDescendants) return balances.get(accountId) ?? 0;
  return sumWithin(await ledger.listAccounts(), balances, accountId, true);
}

/**
 * Register lines for one account with raw running balances, one row per
 * transaction, ordered by date then transaction id.
 * @param ledger repository to read through
 * @param accountId account whose splits to list
 * @param query inclusive `from`/`to` ISO dates; default: unbounded. The running
 *   balance starts from the account balance before `from`.
 * @throws ForeignKeyViolationError for an unknown account
 */
export async function getRegister(
  ledger: LedgerRepo,
  accountId: number,
  query: RegisterQuery = {},
): Promise<RegisterRow[]> {
  if (query.from !== undefined) assertIsoDate(query.from, "from");
  if (query.to !== undefined) assertIsoDate(query.to, "to");
  if ((await ledger.getAccount(accountId)) === null) {
    throw new ForeignKeyViolationError(`Account ${accountId} does not exist.`);
  }
  // Read from the beginning so the running balance includes everything before `from`.
  const splits = await ledger.listSplitsForAccount(
    accountId,
    query.to === undefined ? {} : { to: query.to },
  );
  const accountNames = new Map((await ledger.listAccounts()).map((a) => [a.id, a.name]));

  const grouped: { transaction_id: number; splits: typeof splits }[] = [];
  for (const split of splits) {
    const last = grouped[grouped.length - 1];
    if (last !== undefined && last.transaction_id === split.transaction_id) {
      last.splits.push(split);
    } else {
      grouped.push({ transaction_id: split.transaction_id, splits: [split] });
    }
  }

  const rows: RegisterRow[] = [];
  let running = 0;
  for (const group of grouped) {
    const first = group.splits[0];
    const amount = group.splits.reduce((sum, split) => sum + split.amount_cents, 0);
    running += amount;
    if (query.from !== undefined && first.date < query.from) continue;
    const transaction = await ledger.getTransaction(group.transaction_id);
    if (transaction === null) continue;
    const others = transaction.splits.filter((split) => split.account_id !== accountId);
    const counterpart =
      others.length === 1
        ? (accountNames.get(others[0].account_id) ?? SPLIT_COUNTERPART_LABEL)
        : SPLIT_COUNTERPART_LABEL;
    const states = group.splits.map((split) => split.reconcile_state);
    rows.push({
      transaction,
      transaction_id: first.transaction_id,
      split_id: first.split_id,
      date: first.date,
      payee_id: first.payee_id,
      memo: first.transaction_memo,
      amount_cents: amount,
      reconcile_state: states.includes("y") ? "y" : states.includes("c") ? "c" : "n",
      counterpart,
      running_balance_cents: running,
    });
  }
  return rows;
}

/**
 * Account tree in name order with raw own and rolled-up balances.
 * @param ledger repository to read through
 * @param options `asOf` (default: today, local date) and `includeArchived` (default `false`)
 */
export async function getAccountTree(
  ledger: LedgerRepo,
  { asOf = localToday(), includeArchived = false }: AccountTreeOptions = {},
): Promise<AccountTreeNode[]> {
  assertIsoDate(asOf, "asOf");
  const [accounts, sums] = await Promise.all([
    ledger.listAccounts(),
    ledger.sumSplitsByAccount(asOf),
  ]);
  const own = new Map(sums.map((row) => [row.account_id, row.balance_cents]));

  const byParent = new Map<number | null, LedgerAccount[]>();
  for (const account of accounts) {
    const list = byParent.get(account.parent_id) ?? [];
    list.push(account);
    byParent.set(account.parent_id, list);
  }
  const byName = (a: LedgerAccount, b: LedgerAccount): number =>
    a.name.localeCompare(b.name) || a.id - b.id;

  // Archived accounts are dropped from the output but their subtree is hoisted
  // to the nearest kept ancestor; balances were rolled up before filtering.
  function build(account: LedgerAccount): { nodes: AccountTreeNode[]; rolled: number } {
    const children = [...(byParent.get(account.id) ?? [])].sort(byName);
    let rolled = own.get(account.id) ?? 0;
    const childNodes: AccountTreeNode[] = [];
    for (const child of children) {
      const built = build(child);
      rolled += built.rolled;
      childNodes.push(...built.nodes);
    }
    childNodes.sort((a, b) => byName(a.account, b.account));
    if (account.archived && !includeArchived) return { nodes: childNodes, rolled };
    return {
      nodes: [
        {
          account,
          own_balance_cents: own.get(account.id) ?? 0,
          rolled_up_balance_cents: rolled,
          children: childNodes,
        },
      ],
      rolled,
    };
  }

  const roots = [...(byParent.get(null) ?? [])].sort(byName);
  return roots.flatMap((root) => build(root).nodes);
}

/**
 * Record a transfer as one balanced transaction: `from` gets `−amount`, `to` gets `+amount`.
 * @param ledger repository to write through
 * @param input transfer fields (`memo` and `payee_id` default to `null`)
 * @throws ValidationError for a non-positive amount or identical accounts
 */
export async function createTransfer(
  ledger: LedgerRepo,
  input: TransferInput,
): Promise<Transaction> {
  assertPositiveCents(input.amount_cents);
  if (input.fromAccountId === input.toAccountId) {
    throw new ValidationError("A transfer needs two different accounts.");
  }
  return postTransaction(ledger, {
    date: input.date,
    payee_id: input.payee_id ?? null,
    memo: input.memo ?? null,
    splits: [
      { account_id: input.fromAccountId, amount_cents: -input.amount_cents },
      { account_id: input.toAccountId, amount_cents: input.amount_cents },
    ],
  });
}

/**
 * Record income as one balanced transaction: deposit `+amount`, income `−amount`.
 * @param ledger repository to write through
 * @param input income fields (`memo` and `payee_id` default to `null`)
 * @throws ValidationError for a non-positive amount, a non-INCOME income account or a non-funding deposit account
 */
export async function createIncome(ledger: LedgerRepo, input: IncomeInput): Promise<Transaction> {
  assertPositiveCents(input.amount_cents);
  const [income, deposit] = await Promise.all([
    ledger.getAccount(input.incomeAccountId),
    ledger.getAccount(input.depositAccountId),
  ]);
  if (income === null) {
    throw new ForeignKeyViolationError(`Account ${input.incomeAccountId} does not exist.`);
  }
  if (deposit === null) {
    throw new ForeignKeyViolationError(`Account ${input.depositAccountId} does not exist.`);
  }
  if (income.type !== "INCOME") {
    throw new ValidationError(`Account "${income.name}" is not an INCOME account.`);
  }
  if (!isFundingType(deposit.type)) {
    throw new ValidationError(`Account "${deposit.name}" must be an ASSET or LIABILITY account.`);
  }
  return postTransaction(ledger, {
    date: input.date,
    payee_id: input.payee_id ?? null,
    memo: input.memo ?? null,
    splits: [
      { account_id: input.depositAccountId, amount_cents: input.amount_cents },
      { account_id: input.incomeAccountId, amount_cents: -input.amount_cents },
    ],
  });
}

/**
 * Set an account's opening balance against the Opening Balances equity account.
 * The opening-balance transaction is the one whose splits are exactly two: one
 * on `accountId`, one on the `opening_balances` account. A non-zero amount
 * creates it or replaces it (same id); `0` deletes it.
 * @param ledger repository to write through
 * @param accountId account receiving the opening balance
 * @param date ISO date `YYYY-MM-DD` of the opening balance
 * @param naturalAmountCents natural-sign integer cents (may be 0)
 * @returns the stored transaction, or `null` when the amount is 0
 * @throws ValidationError for placeholder, system and EQUITY accounts
 */
export async function setOpeningBalance(
  ledger: LedgerRepo,
  accountId: number,
  date: string,
  naturalAmountCents: number,
): Promise<Transaction | null> {
  assertIsoDate(date);
  if (!Number.isSafeInteger(naturalAmountCents)) {
    throw new ValidationError("The opening balance must be a safe integer number of cents.");
  }
  const account = await ledger.getAccount(accountId);
  if (account === null) {
    throw new ForeignKeyViolationError(`Account ${accountId} does not exist.`);
  }
  if (account.placeholder || account.system_role !== null || account.type === "EQUITY") {
    throw new ValidationError(
      `Account "${account.name}" cannot take an opening balance (placeholder, system or EQUITY).`,
    );
  }
  const opening = await ledger.getSystemAccount("opening_balances");
  if (opening === null) {
    throw new ValidationError("The Opening Balances account is missing.");
  }

  const candidates = new Set(
    (await ledger.listSplitsForAccount(accountId)).map((s) => s.transaction_id),
  );
  const existing: Transaction[] = [];
  for (const transactionId of [...candidates].sort((a, b) => a - b)) {
    const transaction = await ledger.getTransaction(transactionId);
    if (
      transaction !== null &&
      transaction.splits.length === 2 &&
      transaction.splits.some((split) => split.account_id === opening.id)
    ) {
      existing.push(transaction);
    }
  }

  // Refuse up front when ANY candidate is locked, so nothing is partially written.
  for (const transaction of existing) assertNotReconciled(transaction, "replaced");
  const deleteIds = existing.map((transaction) => transaction.id);

  if (naturalAmountCents === 0) {
    if (deleteIds.length > 0) await ledger.rewriteTransactions({ deleteIds });
    return null;
  }

  const raw = naturalBalance(account.type, naturalAmountCents);
  const next: NewTransaction = {
    date,
    memo: "Opening balance",
    splits: [
      { account_id: accountId, amount_cents: raw },
      { account_id: opening.id, amount_cents: -raw },
    ],
  };
  validateShape(next);
  await validateReferences(ledger, next);
  // One batch: drop the extra candidates and replace (or insert) the survivor.
  const stored = await ledger.rewriteTransactions(
    existing.length === 0
      ? { deleteIds: [], insert: next }
      : {
          deleteIds: deleteIds.slice(1),
          replace: { id: existing[0].id, transaction: next },
        },
  );
  return stored;
}

/**
 * Convert between raw debit-positive cents and natural sign (an involution):
 * ASSET and EXPENSE keep the value, LIABILITY, INCOME and EQUITY negate it.
 * @param type account type
 * @param rawCents signed integer cents
 */
export function naturalBalance(type: AccountType, rawCents: number): number {
  const result = type === "ASSET" || type === "EXPENSE" ? rawCents : -rawCents;
  // Normalize -0 so zero balances compare equal under toBe/Object.is.
  return result === 0 ? 0 : result;
}
