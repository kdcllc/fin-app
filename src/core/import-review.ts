import type { BatchStatement, SqlValue } from "./db";
import type { Account, AccountKind, Category, Payee, XlsxBusinessKey } from "./entities";
import type { XlsxIdentityRow } from "./repositories/ledger";
import type { Repositories } from "./index";

export type DuplicateDecision = "keep" | "skip";

export type ImportDedupState =
  | { kind: "new" }
  | { kind: "exact_duplicate" }
  | { kind: "potential_duplicate"; decision: DuplicateDecision | null; match_count: number };

export interface ImportReviewRow {
  id: string;
  payee_name: string;
  account_name: string;
  account_kind: AccountKind;
  category_name: string | null;
  date: string;
  amount_cents: number;
  source_sheet: string;
  source_row: number;
  source_col: number;
  occurrence_index: number;
  memo: string | null;
  dedup: ImportDedupState;
}

/**
 * Commit progress is per-stage, not per-row: the whole write happens inside
 * one `db.batch()` call, so there is no meaningful per-row signal to report.
 * Stage order: reading → annotating → building → committing → done.
 */
export type ImportCommitStage = "reading" | "annotating" | "building" | "committing" | "done";

export interface ImportCommitProgress {
  stage: ImportCommitStage;
  /** Total review rows in this commit — constant across stages. */
  total_rows: number;
}

export interface ReviewedImportCommitInput {
  source_file: string;
  content_hash: string;
  rows: ImportReviewRow[];
  /** Per-stage progress callback (the contract the import UI consumes). */
  on_progress?: (progress: ImportCommitProgress) => void;
  /**
   * Test hook: poison the batch after N transaction INSERT statements to prove
   * that a mid-batch failure rolls back every statement.
   */
  fail_after_insert_count?: number;
}

export interface ReviewedImportCommitResult {
  inserted_count: number;
  skipped_exact_duplicates: number;
  skipped_potential_duplicates: number;
  import_log_id: number;
}

function keyOf(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function addUniqueByName<T extends { name: string }>(map: Map<string, T>, items: T[]): void {
  for (const item of items) {
    const key = keyOf(item.name);
    if (!map.has(key)) {
      map.set(key, item);
    }
  }
}

interface EntityMaps {
  payeesByName: Map<string, Payee>;
  accountsByName: Map<string, Account>;
  categoriesByName: Map<string, Category>;
}

async function loadEntityMaps(repos: Repositories): Promise<EntityMaps> {
  // Visibility parity: every list includes archived rows so these maps see
  // the same row set the in-batch name subqueries scan. An archived entity
  // whose name reappears is reused (payment history may reference archived
  // entities), never duplicated.
  const [payees, accounts, categories] = await Promise.all([
    repos.payees.list({ includeArchived: true }),
    repos.accounts.list({ includeArchived: true }),
    repos.categories.list({ includeArchived: true }),
  ]);

  const payeesByName = new Map<string, Payee>();
  const accountsByName = new Map<string, Account>();
  const categoriesByName = new Map<string, Category>();

  addUniqueByName(payeesByName, payees);
  addUniqueByName(accountsByName, accounts);
  addUniqueByName(categoriesByName, categories);

  return { payeesByName, accountsByName, categoriesByName };
}

function businessKeyOf(
  payeeId: number,
  accountId: number,
  date: string,
  amountCents: number,
): string {
  return `${payeeId}|${accountId}|${date}|${amountCents}`;
}

/**
 * One batched query pass: fetch every existing xlsx transaction (of ANY shape,
 * so edited multi-split ones count) matching any
 * review row's business key, grouped by that key. Rows whose payee/account
 * do not exist yet cannot have matches (payments FK-reference entities) and
 * contribute no key.
 */
async function loadExistingXlsxMatches(
  repos: Repositories,
  rows: ImportReviewRow[],
  maps: EntityMaps,
): Promise<Map<string, XlsxIdentityRow[]>> {
  const keys: XlsxBusinessKey[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const payee = maps.payeesByName.get(keyOf(row.payee_name));
    const account = maps.accountsByName.get(keyOf(row.account_name));
    if (!payee || !account) continue;
    const key = businessKeyOf(payee.id, account.id, row.date, row.amount_cents);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({
      payee_id: payee.id,
      account_id: account.id,
      date: row.date,
      amount_cents: row.amount_cents,
    });
  }

  const matches = await repos.ledger.listXlsxIdentities(keys);
  const byKey = new Map<string, XlsxIdentityRow[]>();
  for (const identity of matches) {
    const key = businessKeyOf(
      identity.payee_id,
      identity.import_account_id,
      identity.date,
      identity.import_amount_cents,
    );
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(identity);
    } else {
      byKey.set(key, [identity]);
    }
  }
  return byKey;
}

type ComputedDedupState =
  | { kind: "new" }
  | { kind: "exact_duplicate" }
  | { kind: "potential_duplicate"; match_count: number };

function classifyAgainstExisting(
  row: ImportReviewRow,
  maps: EntityMaps,
  existingByKey: Map<string, XlsxIdentityRow[]>,
): ComputedDedupState {
  const payee = maps.payeesByName.get(keyOf(row.payee_name));
  const account = maps.accountsByName.get(keyOf(row.account_name));
  if (!payee || !account) return { kind: "new" };

  const matches =
    existingByKey.get(businessKeyOf(payee.id, account.id, row.date, row.amount_cents)) ?? [];
  if (matches.length === 0) return { kind: "new" };

  const hasExactMatch = matches.some(
    (identity) =>
      identity.source_sheet === row.source_sheet &&
      identity.source_row === row.source_row &&
      identity.source_col === row.source_col &&
      identity.occurrence_index === row.occurrence_index,
  );
  if (hasExactMatch) return { kind: "exact_duplicate" };

  return { kind: "potential_duplicate", match_count: matches.length };
}

export async function annotateImportRowsWithDedup(
  repos: Repositories,
  rows: ImportReviewRow[],
): Promise<ImportReviewRow[]> {
  const maps = await loadEntityMaps(repos);
  const existingByKey = await loadExistingXlsxMatches(repos, rows, maps);

  return rows.map((row) => {
    const state = classifyAgainstExisting(row, maps, existingByKey);
    if (state.kind === "potential_duplicate") {
      const priorDecision = row.dedup.kind === "potential_duplicate" ? row.dedup.decision : null;
      return {
        ...row,
        dedup: {
          kind: "potential_duplicate" as const,
          decision: priorDecision,
          match_count: state.match_count,
        },
      };
    }
    return { ...row, dedup: state };
  });
}

function assertCommitable(rows: ImportReviewRow[]): void {
  for (const row of rows) {
    if (row.payee_name.trim().length === 0) {
      throw new Error(`import commit blocked: row ${row.id} is missing payee_name`);
    }
    if (row.account_name.trim().length === 0) {
      throw new Error(`import commit blocked: row ${row.id} is missing account_name`);
    }
    if (!Number.isInteger(row.occurrence_index) || row.occurrence_index < 1) {
      throw new Error(`import commit blocked: row ${row.id} occurrence_index must be >= 1`);
    }
    if (row.dedup.kind === "potential_duplicate" && row.dedup.decision === null) {
      throw new Error(`import commit blocked: row ${row.id} requires keep/skip duplicate decision`);
    }
  }
}

/**
 * How a statement binds an entity id: a known integer id for entities that
 * already exist, or the exact name this batch inserts, resolved by a
 * deterministic scalar subquery (`SELECT MIN(id) ... WHERE name = ?`) that is
 * restricted to the entity's own account type, so a category and a funding
 * account sharing a name never resolve to each other. The tables have no
 * UNIQUE name constraint, so `INSERT OR IGNORE` is not a dedup mechanism here
 * — TS decides new-vs-existing instead, and inserts each genuinely new name
 * exactly once per batch.
 */
type EntityRef = { id: number } | { pendingName: string };
type EntityTable = "payees" | "funding" | "category";

const ENTITY_LOOKUP_SQL: Record<EntityTable, string> = {
  payees: "SELECT MIN(id) FROM payees WHERE name = ?",
  funding:
    "SELECT MIN(id) FROM accounts WHERE name = ? AND type IN ('ASSET', 'LIABILITY') AND placeholder = 0 AND system_role IS NULL",
  category:
    "SELECT MIN(id) FROM accounts WHERE name = ? AND type = 'EXPENSE' AND placeholder = 0 AND system_role IS NULL",
};

function entityRefSql(
  ref: EntityRef | null,
  table: EntityTable,
): { expr: string; param: SqlValue } {
  if (ref === null) return { expr: "?", param: null };
  if ("id" in ref) return { expr: "?", param: ref.id };
  // MIN(id) as a determinism guard should duplicate names ever exist.
  return { expr: `(${ENTITY_LOOKUP_SQL[table]})`, param: ref.pendingName };
}

/** Ledger type/subtype/root for each legacy account kind. */
const FUNDING_ACCOUNT_SHAPE: Record<
  AccountKind,
  { type: "ASSET" | "LIABILITY"; subtype: string; root: "root_asset" | "root_liability" }
> = {
  checking: { type: "ASSET", subtype: "bank", root: "root_asset" },
  cash: { type: "ASSET", subtype: "cash", root: "root_asset" },
  savings: { type: "ASSET", subtype: "savings", root: "root_asset" },
  credit: { type: "LIABILITY", subtype: "credit_card", root: "root_liability" },
  loan: { type: "LIABILITY", subtype: "loan", root: "root_liability" },
};

/** The Uncategorized system account, used when a row has no category. */
const UNCATEGORIZED_SQL = "(SELECT id FROM accounts WHERE system_role = 'uncategorized')";

function buildCommitStatements(
  input: ReviewedImportCommitInput,
  rowsToInsert: ImportReviewRow[],
  maps: EntityMaps,
): BatchStatement[] {
  const statements: BatchStatement[] = [];

  // keyOf(name) → the exact trimmed name this batch inserts; payments bind
  // that same string so the subquery resolves the row the batch just created.
  const pendingPayees = new Map<string, string>();
  const pendingAccounts = new Map<string, string>();
  const pendingCategories = new Map<string, string>();

  function payeeRef(row: ImportReviewRow): EntityRef {
    const existing = maps.payeesByName.get(keyOf(row.payee_name));
    if (existing) return { id: existing.id };
    const key = keyOf(row.payee_name);
    let pendingName = pendingPayees.get(key);
    if (pendingName === undefined) {
      pendingName = row.payee_name.trim();
      pendingPayees.set(key, pendingName);
      statements.push({ sql: "INSERT INTO payees (name) VALUES (?)", params: [pendingName] });
    }
    return { pendingName };
  }

  function accountRef(row: ImportReviewRow): EntityRef {
    const existing = maps.accountsByName.get(keyOf(row.account_name));
    if (existing) return { id: existing.id };
    const key = keyOf(row.account_name);
    let pendingName = pendingAccounts.get(key);
    if (pendingName === undefined) {
      pendingName = row.account_name.trim();
      pendingAccounts.set(key, pendingName);
      const shape = FUNDING_ACCOUNT_SHAPE[row.account_kind];
      statements.push({
        sql: `INSERT INTO accounts (name, type, subtype, parent_id)
              VALUES (?, ?, ?, (SELECT id FROM accounts WHERE system_role = ?))`,
        params: [pendingName, shape.type, shape.subtype, shape.root],
      });
    }
    return { pendingName };
  }

  function categoryRef(row: ImportReviewRow): EntityRef | null {
    if (row.category_name === null || row.category_name.trim().length === 0) return null;
    const existing = maps.categoriesByName.get(keyOf(row.category_name));
    if (existing) return { id: existing.id };
    const key = keyOf(row.category_name);
    let pendingName = pendingCategories.get(key);
    if (pendingName === undefined) {
      pendingName = row.category_name.trim();
      pendingCategories.set(key, pendingName);
      statements.push({
        sql: `INSERT INTO accounts (name, type, parent_id)
              VALUES (?, 'EXPENSE', (SELECT id FROM accounts WHERE system_role = 'root_expense'))`,
        params: [pendingName],
      });
    }
    return { pendingName };
  }

  let paymentInsertCount = 0;
  for (const row of rowsToInsert) {
    const payee = entityRefSql(payeeRef(row), "payees");
    const account = entityRefSql(accountRef(row), "funding");
    const category = entityRefSql(categoryRef(row), "category");
    // A row without a category lands on the Uncategorized account.
    const categoryExpr = category.param === null ? UNCATEGORIZED_SQL : category.expr;
    const categoryParams: SqlValue[] = category.param === null ? [] : [category.param];

    // Transaction header + two splits (expense +amount, funding -amount). Both
    // split inserts bind the header via MAX(id): same connection and batch.
    statements.push({
      sql: `INSERT INTO transactions (
              date,
              payee_id,
              memo,
              source,
              source_sheet,
              source_row,
              source_col,
              occurrence_index,
              import_account_id,
              import_amount_cents
            )
            VALUES (?, ${payee.expr}, ?, 'xlsx', ?, ?, ?, ?, ${account.expr}, ?)`,
      params: [
        row.date,
        payee.param,
        row.memo,
        row.source_sheet,
        row.source_row,
        row.source_col,
        row.occurrence_index,
        account.param,
        row.amount_cents,
      ],
    });
    statements.push({
      sql: `INSERT INTO splits (transaction_id, account_id, amount_cents)
            VALUES ((SELECT MAX(id) FROM transactions), ${categoryExpr}, ?)`,
      params: [...categoryParams, row.amount_cents],
    });
    statements.push({
      sql: `INSERT INTO splits (transaction_id, account_id, amount_cents)
            VALUES ((SELECT MAX(id) FROM transactions), ${account.expr}, ?)`,
      params: [account.param, row.amount_cents === 0 ? 0 : -row.amount_cents],
    });
    paymentInsertCount += 1;

    if (
      input.fail_after_insert_count !== undefined &&
      paymentInsertCount === input.fail_after_insert_count
    ) {
      // Poison statement: the table does not exist, so this statement fails
      // inside the batch and must roll everything back.
      statements.push({
        sql: 'INSERT INTO "injected failure after payment insert" DEFAULT VALUES',
        params: [],
      });
    }
  }

  statements.push({
    sql: "INSERT INTO import_log (source_file, content_hash, row_count) VALUES (?, ?, ?)",
    params: [input.source_file, input.content_hash, input.rows.length],
  });

  return statements;
}

/**
 * Commit a reviewed import as ONE atomic `db.batch()` call: entity
 * get-or-create, transaction inserts, and the `import_log` append all ride the
 * same transaction — one IPC round trip, one fsync. Skip/insert decisions
 * are computed in TS beforehand from one batched existing-rows query, so
 * every review row is accounted for as inserted, skipped-exact, or
 * skipped-potential (totals reconcile with the input row count).
 */
export async function commitReviewedImport(
  repos: Repositories,
  input: ReviewedImportCommitInput,
): Promise<ReviewedImportCommitResult> {
  const reportProgress = (stage: ImportCommitStage) => {
    input.on_progress?.({ stage, total_rows: input.rows.length });
  };

  assertCommitable(input.rows);

  reportProgress("reading");
  const maps = await loadEntityMaps(repos);

  reportProgress("annotating");
  const existingByKey = await loadExistingXlsxMatches(repos, input.rows, maps);

  let skippedExactDuplicates = 0;
  let skippedPotentialDuplicates = 0;
  const rowsToInsert: ImportReviewRow[] = [];

  for (const row of input.rows) {
    if (row.dedup.kind === "exact_duplicate") {
      skippedExactDuplicates += 1;
      continue;
    }
    if (row.dedup.kind === "potential_duplicate" && row.dedup.decision === "skip") {
      skippedPotentialDuplicates += 1;
      continue;
    }

    // Re-classify against current DB state: review annotations can be stale.
    const commitTimeState = classifyAgainstExisting(row, maps, existingByKey);
    if (commitTimeState.kind === "exact_duplicate") {
      skippedExactDuplicates += 1;
      continue;
    }
    if (commitTimeState.kind === "potential_duplicate") {
      const decision = row.dedup.kind === "potential_duplicate" ? row.dedup.decision : null;
      if (decision === null) {
        throw new Error(
          `import commit blocked: row ${row.id} requires keep/skip duplicate decision`,
        );
      }
    }

    rowsToInsert.push(row);
  }

  reportProgress("building");
  const statements = buildCommitStatements(input, rowsToInsert, maps);

  reportProgress("committing");
  let results;
  try {
    results = await repos.batch(statements);
  } catch (error) {
    // The unique xlsx-identity index is the loud atomic backstop: after the
    // any-shape dedup lookup it fires only when one input carries two rows with
    // the same cell identity. The batch has already rolled back.
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: transactions\./.test(message)) {
      const blocked: Error & { cause?: unknown } = new Error(
        "import commit blocked: a row's xlsx cell identity collides with an existing transaction " +
          "(or with another row in this import). No rows were imported.",
      );
      blocked.cause = error;
      throw blocked;
    }
    throw error;
  }
  const importLogId = results[results.length - 1].lastInsertId;

  reportProgress("done");
  return {
    inserted_count: rowsToInsert.length,
    skipped_exact_duplicates: skippedExactDuplicates,
    skipped_potential_duplicates: skippedPotentialDuplicates,
    import_log_id: importLogId,
  };
}
