/**
 * Public entry of the core data-access layer.
 *
 * BOUNDARY RULE: code outside `src/core/` imports from THIS module only —
 * never from `core/adapters/*` or `core/repositories/*` directly (enforced by
 * the `no-restricted-imports` rule in eslint.config.js). All SQL lives inside
 * this package; UI components never issue queries. See src/core/README.md.
 */
import type { BatchStatement, Database, ExecuteResult } from "./db";
import { createAccountsRepo, type AccountsRepo } from "./repositories/accounts";
import { createCategoriesRepo, type CategoriesRepo } from "./repositories/categories";
import {
  annotateImportRowsWithDedup,
  commitReviewedImport,
  type DuplicateDecision,
  type ImportCommitProgress,
  type ImportCommitStage,
  type ImportDedupState,
  type ImportReviewRow,
  type ReviewedImportCommitInput,
  type ReviewedImportCommitResult,
} from "./import-review";
import {
  buildQuickAddDraft,
  createManualPayment,
  deletePayment,
  formatLocalIsoDate,
  resolvePayeeDefaults,
  updateManualPayment,
  type ManualPaymentInput,
  type PaymentQuickAddDraft,
} from "./payment-entry";
import {
  getBillPayGridForYear,
  type BillPayGrid,
  type BillPayGridCell,
  type BillPayGridCellPayment,
  type BillPayGridMonthTotal,
  type BillPayGridRow,
} from "./payment-grid";
import {
  dismissRecurringBillSuggestion,
  getRecurringBillSuggestions,
  getRecurringDashboardMonth,
  type RecurringBillSuggestion,
  type RecurringBillStatus,
  type RecurringDashboardItem,
  type RecurringDashboardMonth,
  type RecurringDashboardOptions,
} from "./recurring-dashboard";
import { createImportLogRepo, type ImportLogRepo } from "./repositories/import-log";
import { createPaymentsRepo, type PaymentsRepo } from "./repositories/payments";
import { createPayeesRepo, type PayeesRepo } from "./repositories/payees";
import { createRecurringBillsRepo, type RecurringBillsRepo } from "./repositories/recurring-bills";
import { linkReportDatabase } from "./report-db-link";
import {
  allTimeWindow,
  calendarYearWindow,
  formatCentsDecimal,
  formatPaymentsCsv,
  formatReportCsv,
  formatYearSheetCsv,
  listPaymentsForReport,
  runReportQuery,
  trailing12Window,
  validateReportFilter,
  yoyWindowForCalendarYear,
} from "./report-queries";

export type { BatchStatement, Database, ExecuteResult, SqlValue } from "./db";
export {
  DatabaseLockedError,
  EntityInUseError,
  ForeignKeyViolationError,
  PayeeMergeError,
  ValidationError,
  isSqliteLockErrorMessage,
  mapSqliteError,
} from "./errors";
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
  XlsxBusinessKey,
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
export type {
  ReportDimension,
  ReportFilter,
  ReportGrain,
  ReportPaymentRow,
  ReportQuerySpec,
  ReportRow,
} from "./report-queries";
export {
  allTimeWindow,
  annotateImportRowsWithDedup,
  calendarYearWindow,
  commitReviewedImport,
  formatCentsDecimal,
  formatPaymentsCsv,
  formatReportCsv,
  formatYearSheetCsv,
  getBillPayGridForYear,
  buildQuickAddDraft,
  createManualPayment,
  deletePayment,
  formatLocalIsoDate,
  listPaymentsForReport,
  resolvePayeeDefaults,
  runReportQuery,
  trailing12Window,
  updateManualPayment,
  validateReportFilter,
  yoyWindowForCalendarYear,
  getRecurringDashboardMonth,
  getRecurringBillSuggestions,
  dismissRecurringBillSuggestion,
};
export type {
  BillPayGrid,
  BillPayGridCell,
  BillPayGridCellPayment,
  BillPayGridMonthTotal,
  BillPayGridRow,
  DuplicateDecision,
  ImportCommitProgress,
  ImportCommitStage,
  ImportDedupState,
  ImportReviewRow,
  ManualPaymentInput,
  PaymentQuickAddDraft,
  RecurringBillStatus,
  RecurringDashboardItem,
  RecurringDashboardMonth,
  RecurringDashboardOptions,
  RecurringBillSuggestion,
  ReviewedImportCommitInput,
  ReviewedImportCommitResult,
};
export { openRustSqliteDatabase } from "./adapters/rust-sqlite";
export { SUPPORTED_GNUCASH_RESAVE } from "./gnucash-types";
export type {
  GnucashAccount,
  GnucashAccountType,
  GnucashBookProbe,
  GnucashSplit,
  GnucashTransaction,
  GnucashTransactionError,
  GnucashTransactionList,
} from "./gnucash-types";
export {
  GnucashMappingConflictError,
  applyAccountMapping,
  applyCategoryMapping,
  clearMapping,
  mappingStatus,
  suggestAccountMappings,
  suggestCategoryMappings,
} from "./gnucash-mapping";
export type { MappingKind, MappingStatus, MappingSuggestion } from "./gnucash-mapping";
export { commitGnucashImport, planGnucashImport } from "./gnucash-import";
export type {
  GnucashImportApproval,
  GnucashImportFieldDiff,
  GnucashImportOptions,
  GnucashImportPlan,
  GnucashImportPlanMergeCandidateRow,
  GnucashImportPlanNewRow,
  GnucashImportPlanUnchangedRow,
  GnucashImportPlanUnmappableRow,
  GnucashImportPlanUnreadableRow,
  GnucashImportPlanUpdatedRow,
  GnucashImportResult,
} from "./gnucash-import";
export {
  buildCsv,
  buildQif,
  listExportablePayments,
  recordExport,
  validateForExport,
} from "./gnucash-export";
export type {
  ExportBlocker,
  ExportBuildInput,
  ExportFilters,
  ExportHistoryEntry,
  ExportValidation,
  ExportablePayment,
} from "./gnucash-export";
export {
  clearOverride,
  reconcile,
  setManualMatch,
  setManualUnmatch,
  summarize,
} from "./gnucash-reconcile";
export type {
  ReconcileMatchedPair,
  ReconcileOptions,
  ReconcileResult,
  ReconcileSummary,
} from "./gnucash-reconcile";

/** Every repository, wired to one database connection. */
export interface Repositories {
  accounts: AccountsRepo;
  categories: CategoriesRepo;
  importLog: ImportLogRepo;
  payees: PayeesRepo;
  payments: PaymentsRepo;
  recurringBills: RecurringBillsRepo;
  /**
   * Run a prebuilt statement list as ONE atomic SQLite transaction in a
   * single round trip — the import-commit path. Must not be called inside
   * `withTransaction` (SQLite cannot nest transactions).
   */
  batch(statements: BatchStatement[]): Promise<ExecuteResult[]>;
  /** Execute repository operations atomically in one transaction. */
  withTransaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

/** Wire all repositories to a `Database` (any adapter). */
export function createRepositories(db: Database): Repositories {
  function wire(database: Database): Repositories {
    const repos: Repositories = {
      accounts: createAccountsRepo(database),
      categories: createCategoriesRepo(database),
      importLog: createImportLogRepo(database),
      payees: createPayeesRepo(database),
      payments: createPaymentsRepo(database),
      recurringBills: createRecurringBillsRepo(database),
      batch(statements: BatchStatement[]): Promise<ExecuteResult[]> {
        return database.batch(statements);
      },
      withTransaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
        return database.transaction((txDb) => work(wire(txDb)));
      },
    };
    linkReportDatabase(repos, database);
    return repos;
  }

  return wire(db);
}
