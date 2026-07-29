import type { Account, AccountKind, Category, Payee } from "./entities";
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

export interface ReviewedImportCommitInput {
  source_file: string;
  content_hash: string;
  rows: ImportReviewRow[];
  /** Test hook: throw after N successful payment inserts to prove rollback behavior. */
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

async function loadEntityMaps(repos: Repositories): Promise<{
  payeesByName: Map<string, Payee>;
  accountsByName: Map<string, Account>;
  categoriesByName: Map<string, Category>;
}> {
  const [payees, accounts, categories] = await Promise.all([
    repos.payees.list({ includeArchived: true }),
    repos.accounts.list({ includeArchived: true }),
    repos.categories.list(),
  ]);

  const payeesByName = new Map<string, Payee>();
  const accountsByName = new Map<string, Account>();
  const categoriesByName = new Map<string, Category>();

  addUniqueByName(payeesByName, payees);
  addUniqueByName(accountsByName, accounts);
  addUniqueByName(categoriesByName, categories);

  return { payeesByName, accountsByName, categoriesByName };
}

async function getOrCreatePayee(
  repos: Repositories,
  payeesByName: Map<string, Payee>,
  payeeName: string,
): Promise<Payee> {
  const existing = payeesByName.get(keyOf(payeeName));
  if (existing) return existing;

  const created = await repos.payees.insert({ name: payeeName.trim() });
  payeesByName.set(keyOf(created.name), created);
  return created;
}

async function getOrCreateAccount(
  repos: Repositories,
  accountsByName: Map<string, Account>,
  accountName: string,
  accountKind: AccountKind,
): Promise<Account> {
  const existing = accountsByName.get(keyOf(accountName));
  if (existing) return existing;

  const created = await repos.accounts.insert({
    name: accountName.trim(),
    kind: accountKind,
  });
  accountsByName.set(keyOf(created.name), created);
  return created;
}

async function getOrCreateCategory(
  repos: Repositories,
  categoriesByName: Map<string, Category>,
  categoryName: string | null,
): Promise<Category | null> {
  if (categoryName === null || categoryName.trim().length === 0) {
    return null;
  }

  const existing = categoriesByName.get(keyOf(categoryName));
  if (existing) return existing;

  const created = await repos.categories.insert({ name: categoryName.trim() });
  categoriesByName.set(keyOf(created.name), created);
  return created;
}

export async function annotateImportRowsWithDedup(
  repos: Repositories,
  rows: ImportReviewRow[],
): Promise<ImportReviewRow[]> {
  const { payeesByName, accountsByName } = await loadEntityMaps(repos);

  const annotated: ImportReviewRow[] = [];
  for (const row of rows) {
    const payee = payeesByName.get(keyOf(row.payee_name));
    const account = accountsByName.get(keyOf(row.account_name));

    if (!payee || !account) {
      annotated.push({ ...row, dedup: { kind: "new" } });
      continue;
    }

    const dedup = await repos.payments.checkXlsxDedup({
      payee_id: payee.id,
      account_id: account.id,
      date: row.date,
      amount_cents: row.amount_cents,
      source_sheet: row.source_sheet,
      source_row: row.source_row,
      source_col: row.source_col,
      occurrence_index: row.occurrence_index,
    });

    if (dedup.kind === "new") {
      annotated.push({ ...row, dedup: { kind: "new" } });
      continue;
    }

    if (dedup.kind === "exact_duplicate") {
      annotated.push({ ...row, dedup: { kind: "exact_duplicate" } });
      continue;
    }

    const priorDecision = row.dedup.kind === "potential_duplicate" ? row.dedup.decision : null;
    annotated.push({
      ...row,
      dedup: {
        kind: "potential_duplicate",
        decision: priorDecision,
        match_count: dedup.matches.length,
      },
    });
  }

  return annotated;
}

function assertCommitable(rows: ImportReviewRow[]): void {
  for (const row of rows) {
    if (row.payee_name.trim().length === 0) {
      throw new Error(`import commit blocked: row ${row.id} is missing payee_name`);
    }
    if (row.account_name.trim().length === 0) {
      throw new Error(`import commit blocked: row ${row.id} is missing account_name`);
    }
    if (row.dedup.kind === "potential_duplicate" && row.dedup.decision === null) {
      throw new Error(`import commit blocked: row ${row.id} requires keep/skip duplicate decision`);
    }
  }
}

export async function commitReviewedImport(
  repos: Repositories,
  input: ReviewedImportCommitInput,
): Promise<ReviewedImportCommitResult> {
  assertCommitable(input.rows);

  return repos.withTransaction(async (tx) => {
    const { payeesByName, accountsByName, categoriesByName } = await loadEntityMaps(tx);

    let insertedCount = 0;
    let skippedExactDuplicates = 0;
    let skippedPotentialDuplicates = 0;

    for (const row of input.rows) {
      if (row.dedup.kind === "exact_duplicate") {
        skippedExactDuplicates += 1;
        continue;
      }
      if (row.dedup.kind === "potential_duplicate" && row.dedup.decision === "skip") {
        skippedPotentialDuplicates += 1;
        continue;
      }

      const payee = await getOrCreatePayee(tx, payeesByName, row.payee_name);
      const account = await getOrCreateAccount(tx, accountsByName, row.account_name, row.account_kind);
      const category = await getOrCreateCategory(tx, categoriesByName, row.category_name);

      const dedupNow = await tx.payments.checkXlsxDedup({
        payee_id: payee.id,
        account_id: account.id,
        date: row.date,
        amount_cents: row.amount_cents,
        source_sheet: row.source_sheet,
        source_row: row.source_row,
        source_col: row.source_col,
        occurrence_index: row.occurrence_index,
      });

      if (dedupNow.kind === "exact_duplicate") {
        skippedExactDuplicates += 1;
        continue;
      }
      if (dedupNow.kind === "potential_duplicate") {
        const decision =
          row.dedup.kind === "potential_duplicate" ? row.dedup.decision : null;
        if (decision === "skip") {
          skippedPotentialDuplicates += 1;
          continue;
        }
        if (decision === null) {
          throw new Error(`import commit blocked: row ${row.id} requires keep/skip duplicate decision`);
        }
      }

      await tx.payments.insert({
        payee_id: payee.id,
        account_id: account.id,
        category_id: category?.id ?? null,
        date: row.date,
        amount_cents: row.amount_cents,
        memo: row.memo,
        source: "xlsx",
        source_sheet: row.source_sheet,
        source_row: row.source_row,
        source_col: row.source_col,
        occurrence_index: row.occurrence_index,
      });
      insertedCount += 1;

      if (
        input.fail_after_insert_count !== undefined &&
        insertedCount >= input.fail_after_insert_count
      ) {
        throw new Error("injected failure after payment insert");
      }
    }

    const logEntry = await tx.importLog.append({
      source_file: input.source_file,
      content_hash: input.content_hash,
      row_count: input.rows.length,
    });

    return {
      inserted_count: insertedCount,
      skipped_exact_duplicates: skippedExactDuplicates,
      skipped_potential_duplicates: skippedPotentialDuplicates,
      import_log_id: logEntry.id,
    };
  });
}
