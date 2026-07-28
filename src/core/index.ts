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
import { createImportLogRepo, type ImportLogRepo } from "./repositories/import-log";
import { createPaymentsRepo, type PaymentsRepo } from "./repositories/payments";
import { createPayeesRepo, type PayeesRepo } from "./repositories/payees";
import { createRecurringBillsRepo, type RecurringBillsRepo } from "./repositories/recurring-bills";

export type { Database, ExecuteResult, SqlValue } from "./db";
export { ForeignKeyViolationError, mapSqliteError } from "./errors";
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
} from "./entities";
export type { AccountsRepo } from "./repositories/accounts";
export type { CategoriesRepo } from "./repositories/categories";
export type { ImportLogRepo } from "./repositories/import-log";
export type { PaymentFilter, PaymentsRepo } from "./repositories/payments";
export type { PayeesRepo } from "./repositories/payees";
export type { RecurringBillsRepo } from "./repositories/recurring-bills";
export { openTauriDatabase } from "./adapters/tauri-sql";

/** Every repository, wired to one database connection. */
export interface Repositories {
  accounts: AccountsRepo;
  categories: CategoriesRepo;
  importLog: ImportLogRepo;
  payees: PayeesRepo;
  payments: PaymentsRepo;
  recurringBills: RecurringBillsRepo;
}

/** Wire all repositories to a `Database` (any adapter). */
export function createRepositories(db: Database): Repositories {
  return {
    accounts: createAccountsRepo(db),
    categories: createCategoriesRepo(db),
    importLog: createImportLogRepo(db),
    payees: createPayeesRepo(db),
    payments: createPaymentsRepo(db),
    recurringBills: createRecurringBillsRepo(db),
  };
}
