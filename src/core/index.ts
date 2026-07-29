/**
 * Public entry of the core data-access layer.
 *
 * BOUNDARY RULE: code outside `src/core/` imports from THIS module only —
 * never from `core/adapters/*` or `core/repositories/*` directly (enforced by
 * the `no-restricted-imports` rule in eslint.config.js). All SQL lives inside
 * this package; UI components never issue queries. See src/core/README.md.
 */
import type { Database } from "./db";
import { createAccountsRepo, type AccountsRepo } from "./repositories/accounts";
import { createCategoriesRepo, type CategoriesRepo } from "./repositories/categories";
import {
  annotateImportRowsWithDedup,
  commitReviewedImport,
  type DuplicateDecision,
  type ImportDedupState,
  type ImportReviewRow,
  type ReviewedImportCommitInput,
  type ReviewedImportCommitResult,
} from "./import-review";
import { createImportLogRepo, type ImportLogRepo } from "./repositories/import-log";
import { createPaymentsRepo, type PaymentsRepo } from "./repositories/payments";
import { createPayeesRepo, type PayeesRepo } from "./repositories/payees";
import { createRecurringBillsRepo, type RecurringBillsRepo } from "./repositories/recurring-bills";

export type { Database, ExecuteResult, SqlValue } from "./db";
export { ForeignKeyViolationError, mapSqliteError } from "./errors";
export { parsePaymentCells } from "./cell-parser";
export { buildPayeeProposals, normalizePayeeLabel } from "./payee-normalization";
export type {
  Account,
  AccountKind,
  AccountPatch,
  BillFrequency,
  Category,
  CategoryPatch,
  ImportLogEntry,
  NewAccount,
  NewCategory,
  NewImportLogEntry,
  NewPayee,
  NewPayment,
  NewRecurringBill,
  Payee,
  PayeePatch,
  Payment,
  PaymentPatch,
  PaymentSource,
  RecurringBill,
  RecurringBillPatch,
    XlsxDedupCheckResult,
    XlsxPaymentIdentity,
} from "./entities";
export type {
  AccountHint,
  AccountHintKind,
  CategorySuggestion,
  NormalizedPayeeLabel,
  PayeeProposal,
} from "./payee-normalization";
export type {
  ParsePaymentCellsResult,
  ParsedPaymentCellRecord,
  PaymentCellInput,
  UnparsedPaymentCell,
} from "./cell-parser";
export type { AccountsRepo } from "./repositories/accounts";
export type { CategoriesRepo } from "./repositories/categories";
export type { ImportLogRepo } from "./repositories/import-log";
export type { PaymentFilter, PaymentsRepo } from "./repositories/payments";
export type { PayeesRepo } from "./repositories/payees";
export type { RecurringBillsRepo } from "./repositories/recurring-bills";
export {
  annotateImportRowsWithDedup,
  commitReviewedImport,
};
export type {
  DuplicateDecision,
  ImportDedupState,
  ImportReviewRow,
  ReviewedImportCommitInput,
  ReviewedImportCommitResult,
};
export { openTauriDatabase } from "./adapters/tauri-sql";

/** Every repository, wired to one database connection. */
export interface Repositories {
  accounts: AccountsRepo;
  categories: CategoriesRepo;
  importLog: ImportLogRepo;
  payees: PayeesRepo;
  payments: PaymentsRepo;
  recurringBills: RecurringBillsRepo;
  /** Execute repository operations atomically in one transaction. */
  withTransaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

/** Wire all repositories to a `Database` (any adapter). */
export function createRepositories(db: Database): Repositories {
  function wire(database: Database): Repositories {
    return {
      accounts: createAccountsRepo(database),
      categories: createCategoriesRepo(database),
      importLog: createImportLogRepo(database),
      payees: createPayeesRepo(database),
      payments: createPaymentsRepo(database),
      recurringBills: createRecurringBillsRepo(database),
      withTransaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
        return database.transaction((txDb) => work(wire(txDb)));
      },
    };
  }

  return wire(db);
}
