import type { Payment } from "./entities";
import { ValidationError } from "./errors";
import type { Repositories } from "./index";

export interface PaymentQuickAddDraft {
  payee_id: number | null;
  account_id: number | null;
  category_id: number | null;
  date: string;
  amount_cents: number | null;
  memo: string;
}

export interface ManualPaymentInput {
  payee_id: number;
  account_id: number;
  category_id: number | null;
  date: string;
  amount_cents: number;
  memo?: string | null;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatLocalIsoDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() + 1 === month &&
    candidate.getUTCDate() === day
  );
}

function assertValidEntityId(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${name} is required.`);
  }
}

function normalizeMemo(memo?: string | null): string | null {
  if (memo === undefined || memo === null) return null;
  const trimmed = memo.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function assertValidManualInput(input: ManualPaymentInput): void {
  assertValidEntityId("Payee", input.payee_id);
  assertValidEntityId("Account", input.account_id);
  if (input.category_id !== null) {
    assertValidEntityId("Category", input.category_id);
  }

  if (!isValidIsoDate(input.date)) {
    throw new ValidationError("Date must use YYYY-MM-DD.");
  }

  if (!Number.isInteger(input.amount_cents)) {
    throw new ValidationError("Amount must be entered as exact cents.");
  }
  if (input.amount_cents <= 0) {
    throw new ValidationError("Amount must be greater than zero.");
  }
}

export async function resolvePayeeDefaults(
  repos: Repositories,
  payeeId: number,
): Promise<{ payee_id: number; account_id: number | null; category_id: number | null }> {
  assertValidEntityId("Payee", payeeId);

  const payee = await repos.payees.get(payeeId);
  if (!payee || payee.archived) {
    throw new ValidationError("Selected payee is not available.");
  }

  return {
    payee_id: payee.id,
    account_id: payee.default_account_id,
    category_id: payee.default_category_id,
  };
}

export async function buildQuickAddDraft(
  repos: Repositories,
  payeeId: number,
  now: Date = new Date(),
): Promise<PaymentQuickAddDraft> {
  const defaults = await resolvePayeeDefaults(repos, payeeId);
  return {
    ...defaults,
    date: formatLocalIsoDate(now),
    amount_cents: null,
    memo: "",
  };
}

export async function createManualPayment(
  repos: Repositories,
  input: ManualPaymentInput,
): Promise<Payment> {
  assertValidManualInput(input);
  return repos.payments.insert({
    payee_id: input.payee_id,
    account_id: input.account_id,
    category_id: input.category_id,
    date: input.date,
    amount_cents: input.amount_cents,
    memo: normalizeMemo(input.memo),
    source: "manual",
  });
}

export async function updateManualPayment(
  repos: Repositories,
  id: number,
  input: ManualPaymentInput,
): Promise<Payment | null> {
  assertValidEntityId("Payment", id);
  assertValidManualInput(input);
  return repos.payments.update(id, {
    payee_id: input.payee_id,
    account_id: input.account_id,
    category_id: input.category_id,
    date: input.date,
    amount_cents: input.amount_cents,
    memo: normalizeMemo(input.memo),
  });
}

export async function deletePayment(repos: Repositories, id: number): Promise<boolean> {
  assertValidEntityId("Payment", id);
  return repos.payments.delete(id);
}
