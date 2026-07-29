import type { BillFrequency, RecurringBill } from "./entities";
import type { Repositories } from "./index";

export interface RecurringDashboardOptions {
  year: number;
  month: number;
  toleranceCents: number;
  /** Defaults to the end of the selected month. */
  asOfDate?: string;
}

export type RecurringBillStatus = "due" | "paid" | "overdue";

export interface RecurringDashboardItem {
  recurring_bill_id: number;
  payee_id: number;
  payee_name: string;
  frequency: BillFrequency;
  due_date: string;
  expected_amount_cents: number | null;
  matched_payment_id: number | null;
  matched_amount_cents: number | null;
  amount_delta_cents: number | null;
  status: RecurringBillStatus;
}

export interface RecurringDashboardMonth {
  year: number;
  month: number;
  as_of_date: string;
  tolerance_cents: number;
  month_to_date_spent_cents: number;
  due: RecurringDashboardItem[];
  paid: RecurringDashboardItem[];
  overdue: RecurringDashboardItem[];
  warnings: string[];
}

export interface RecurringBillSuggestion {
  payee_id: number;
  payee_name: string;
  frequency: BillFrequency;
  expected_amount_cents: number | null;
  due_day: number;
  anchor_month: number;
  anchor_phase: number;
  sample_payment_count: number;
  last_payment_date: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function clampDueDay(year: number, month: number, dueDay: number): number {
  return Math.min(dueDay, daysInMonth(year, month));
}

function monthWindow(year: number, month: number): { from: string; to: string } {
  return {
    from: `${year}-${pad2(month)}-01`,
    to: `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
  };
}

function getDefaultAsOfDate(year: number, month: number): string {
  return monthWindow(year, month).to;
}

function normalizeMonthToPhase(month: number): number {
  return ((month - 1) % 3) + 1;
}

function billIsDueThisMonth(bill: RecurringBill, month: number): boolean {
  if (bill.frequency === "monthly") return true;
  if (bill.frequency === "quarterly") {
    return normalizeMonthToPhase(month) === bill.anchor_phase;
  }
  return month === bill.anchor_month;
}

function toMonthIndex(isoDate: string): number {
  const year = Number.parseInt(isoDate.slice(0, 4), 10);
  const month = Number.parseInt(isoDate.slice(5, 7), 10);
  return year * 12 + (month - 1);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function classifyFrequency(monthIndices: number[]): BillFrequency | null {
  if (monthIndices.length < 2) return null;
  const sorted = [...monthIndices].sort((left, right) => left - right);
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    gaps.push(sorted[index] - sorted[index - 1]);
  }

  const ratio = (targetGap: number): number => {
    const matches = gaps.filter((gap) => gap === targetGap).length;
    return matches / gaps.length;
  };

  const monthlyScore = ratio(1);
  const quarterlyScore = ratio(3);
  const annualScore = ratio(12);

  if (sorted.length >= 4 && monthlyScore >= 0.7) return "monthly";
  if (sorted.length >= 4 && quarterlyScore >= 0.7) return "quarterly";
  if (sorted.length >= 3 && annualScore >= 0.7) return "annual";
  return null;
}

function suggestionSignature(suggestion: {
  payee_id: number;
  frequency: BillFrequency;
  due_day: number;
  expected_amount_cents: number | null;
  anchor_month: number;
  anchor_phase: number;
}): string {
  return [
    suggestion.payee_id,
    suggestion.frequency,
    suggestion.due_day,
    suggestion.expected_amount_cents === null ? "null" : String(suggestion.expected_amount_cents),
    suggestion.anchor_month,
    suggestion.anchor_phase,
  ].join("|");
}

function legacySuggestionSignature(suggestion: {
  payee_id: number;
  frequency: BillFrequency;
  due_day: number;
  expected_amount_cents: number | null;
}): string {
  return [
    suggestion.payee_id,
    suggestion.frequency,
    suggestion.due_day,
    suggestion.expected_amount_cents === null ? "null" : String(suggestion.expected_amount_cents),
  ].join("|");
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((left, right) => {
    if (left[1] !== right[1]) return right[1] - left[1];
    return left[0] - right[0];
  });
  return sorted[0][0];
}

function inferSuggestionAnchors(
  frequency: BillFrequency,
  payments: Array<{ date: string; amount_cents: number }>,
): { anchor_month: number; anchor_phase: number } {
  const months = payments.map((payment) => Number.parseInt(payment.date.slice(5, 7), 10));
  const anchorMonth = mode(months);
  if (frequency === "quarterly") {
    return { anchor_month: anchorMonth, anchor_phase: normalizeMonthToPhase(anchorMonth) };
  }
  if (frequency === "annual") {
    return { anchor_month: anchorMonth, anchor_phase: normalizeMonthToPhase(anchorMonth) };
  }
  return { anchor_month: 1, anchor_phase: 1 };
}

function pickMatchingPayment(
  bill: RecurringBill,
  toleranceCents: number,
  paymentsForPayee: Array<{ id: number; amount_cents: number; date: string }>,
): { id: number; amount_cents: number } | null {
  if (paymentsForPayee.length === 0) return null;

  if (bill.expected_amount_cents === null) {
    return { id: paymentsForPayee[0].id, amount_cents: paymentsForPayee[0].amount_cents };
  }

  const sortedByDelta = [...paymentsForPayee].sort((left, right) => {
    const leftDelta = Math.abs(left.amount_cents - bill.expected_amount_cents!);
    const rightDelta = Math.abs(right.amount_cents - bill.expected_amount_cents!);
    if (leftDelta !== rightDelta) return leftDelta - rightDelta;
    const dateOrder = left.date.localeCompare(right.date);
    return dateOrder !== 0 ? dateOrder : left.id - right.id;
  });

  const best = sortedByDelta[0];
  const delta = Math.abs(best.amount_cents - bill.expected_amount_cents);
  if (delta > toleranceCents) return null;
  return { id: best.id, amount_cents: best.amount_cents };
}

export async function getRecurringDashboardMonth(
  repos: Repositories,
  options: RecurringDashboardOptions,
): Promise<RecurringDashboardMonth> {
  if (!Number.isInteger(options.year)) throw new Error("Year must be an integer.");
  if (!Number.isInteger(options.month) || options.month < 1 || options.month > 12) {
    throw new Error("Month must be an integer from 1 to 12.");
  }
  if (!Number.isInteger(options.toleranceCents) || options.toleranceCents < 0) {
    throw new Error("Amount tolerance must be an integer >= 0 cents.");
  }

  const asOfDate = options.asOfDate ?? getDefaultAsOfDate(options.year, options.month);
  const window = monthWindow(options.year, options.month);

  const [payees, recurringBills, payments] = await Promise.all([
    repos.payees.list({ includeArchived: true }),
    repos.recurringBills.list({ activeOnly: true }),
    repos.payments.list(window),
  ]);

  const payeeById = new Map(payees.map((payee) => [payee.id, payee] as const));
  const paymentsByPayee = new Map<number, Array<{ id: number; amount_cents: number; date: string }>>();
  let monthToDateSpentCents = 0;

  for (const payment of payments) {
    monthToDateSpentCents += payment.amount_cents;
    const bucket = paymentsByPayee.get(payment.payee_id) ?? [];
    bucket.push({ id: payment.id, amount_cents: payment.amount_cents, date: payment.date });
    paymentsByPayee.set(payment.payee_id, bucket);
  }

  const warnings: string[] = [];
  const due: RecurringDashboardItem[] = [];
  const paid: RecurringDashboardItem[] = [];
  const overdue: RecurringDashboardItem[] = [];

  for (const bill of recurringBills) {
    if (!billIsDueThisMonth(bill, options.month)) continue;

    const payee = payeeById.get(bill.payee_id);
    if (!payee) {
      warnings.push(`Recurring bill ${bill.id} references missing payee id ${bill.payee_id}.`);
      continue;
    }

    const dueDay = clampDueDay(options.year, options.month, bill.due_day);
    const dueDate = `${options.year}-${pad2(options.month)}-${pad2(dueDay)}`;
    const matched = pickMatchingPayment(
      bill,
      options.toleranceCents,
      paymentsByPayee.get(bill.payee_id) ?? [],
    );

    const item: RecurringDashboardItem = {
      recurring_bill_id: bill.id,
      payee_id: bill.payee_id,
      payee_name: payee.name,
      frequency: bill.frequency,
      due_date: dueDate,
      expected_amount_cents: bill.expected_amount_cents,
      matched_payment_id: matched?.id ?? null,
      matched_amount_cents: matched?.amount_cents ?? null,
      amount_delta_cents:
        matched && bill.expected_amount_cents !== null
          ? matched.amount_cents - bill.expected_amount_cents
          : null,
      status: "due",
    };

    if (matched) {
      item.status = "paid";
      paid.push(item);
      continue;
    }

    if (dueDate < asOfDate) {
      item.status = "overdue";
      overdue.push(item);
      continue;
    }

    due.push(item);
  }

  const byDueDateThenName = (left: RecurringDashboardItem, right: RecurringDashboardItem): number => {
    const dateOrder = left.due_date.localeCompare(right.due_date);
    if (dateOrder !== 0) return dateOrder;
    const nameOrder = left.payee_name.localeCompare(right.payee_name);
    return nameOrder !== 0 ? nameOrder : left.recurring_bill_id - right.recurring_bill_id;
  };

  due.sort(byDueDateThenName);
  paid.sort(byDueDateThenName);
  overdue.sort(byDueDateThenName);

  return {
    year: options.year,
    month: options.month,
    as_of_date: asOfDate,
    tolerance_cents: options.toleranceCents,
    month_to_date_spent_cents: monthToDateSpentCents,
    due,
    paid,
    overdue,
    warnings,
  };
}

export async function getRecurringBillSuggestions(
  repos: Repositories,
  options?: { lookbackMonths?: number; throughDate?: string },
): Promise<RecurringBillSuggestion[]> {
  const lookbackMonths = options?.lookbackMonths ?? 18;
  if (!Number.isInteger(lookbackMonths) || lookbackMonths < 2) {
    throw new Error("lookbackMonths must be an integer >= 2.");
  }

  const throughDate = options?.throughDate ?? new Date().toISOString().slice(0, 10);
  const throughYear = Number.parseInt(throughDate.slice(0, 4), 10);
  const throughMonth = Number.parseInt(throughDate.slice(5, 7), 10);
  if (!Number.isInteger(throughYear) || !Number.isInteger(throughMonth)) {
    throw new Error("throughDate must be an ISO date (YYYY-MM-DD).");
  }

  const throughIndex = throughYear * 12 + (throughMonth - 1);
  const fromIndex = throughIndex - (lookbackMonths - 1);
  const fromYear = Math.floor(fromIndex / 12);
  const fromMonth = (fromIndex % 12) + 1;
  const fromDate = `${fromYear}-${pad2(fromMonth)}-01`;

  const [payees, recurringBills, payments, dismissed] = await Promise.all([
    repos.payees.list({ includeArchived: true }),
    repos.recurringBills.list(),
    repos.payments.list({ from: fromDate, to: throughDate }),
    repos.recurringBills.listSuggestionDismissals(),
  ]);

  const payeeById = new Map(payees.map((payee) => [payee.id, payee] as const));
  const payeesWithRecurring = new Set(recurringBills.map((bill) => bill.payee_id));
  const dismissedSignatures = new Set(
    dismissed.map((entry) => entry.signature),
  );

  const paymentsByPayee = new Map<number, Array<{ date: string; amount_cents: number }>>();
  for (const payment of payments) {
    const bucket = paymentsByPayee.get(payment.payee_id) ?? [];
    bucket.push({ date: payment.date, amount_cents: payment.amount_cents });
    paymentsByPayee.set(payment.payee_id, bucket);
  }

  const suggestions: RecurringBillSuggestion[] = [];
  for (const [payeeId, payeePayments] of paymentsByPayee) {
    if (payeesWithRecurring.has(payeeId)) continue;
    if (payeePayments.length < 3) continue;

    const payee = payeeById.get(payeeId);
    if (!payee || payee.archived) continue;

    const monthIndices = [...new Set(payeePayments.map((payment) => toMonthIndex(payment.date)))];
    const frequency = classifyFrequency(monthIndices);
    if (!frequency) continue;

    const dueDay = median(payeePayments.map((payment) => Number.parseInt(payment.date.slice(8, 10), 10)));
    const expectedAmountCents = median(payeePayments.map((payment) => payment.amount_cents));
    const sortedByDate = [...payeePayments].sort((left, right) => left.date.localeCompare(right.date));
    const lastPaymentDate = sortedByDate[sortedByDate.length - 1].date;

    const candidate: RecurringBillSuggestion = {
      payee_id: payeeId,
      payee_name: payee.name,
      frequency,
      expected_amount_cents: expectedAmountCents,
      due_day: dueDay,
      ...inferSuggestionAnchors(frequency, payeePayments),
      sample_payment_count: payeePayments.length,
      last_payment_date: lastPaymentDate,
    };

    const anchoredSignature = suggestionSignature({
      payee_id: candidate.payee_id,
      frequency: candidate.frequency,
      due_day: candidate.due_day,
      expected_amount_cents: candidate.expected_amount_cents,
      anchor_month: candidate.anchor_month,
      anchor_phase: candidate.anchor_phase,
    });
    const legacySignature = legacySuggestionSignature({
      payee_id: candidate.payee_id,
      frequency: candidate.frequency,
      due_day: candidate.due_day,
      expected_amount_cents: candidate.expected_amount_cents,
    });

    if (dismissedSignatures.has(anchoredSignature) || dismissedSignatures.has(legacySignature)) {
      continue;
    }

    suggestions.push(candidate);
  }

  suggestions.sort((left, right) => {
    const payeeOrder = left.payee_name.localeCompare(right.payee_name);
    if (payeeOrder !== 0) return payeeOrder;
    return left.payee_id - right.payee_id;
  });

  return suggestions;
}

export async function dismissRecurringBillSuggestion(
  repos: Repositories,
  suggestion: Pick<RecurringBillSuggestion, "payee_id" | "frequency" | "due_day" | "expected_amount_cents" | "anchor_month" | "anchor_phase">,
): Promise<void> {
  await repos.recurringBills.dismissSuggestion({
    payee_id: suggestion.payee_id,
    frequency: suggestion.frequency,
    due_day: suggestion.due_day,
    expected_amount_cents: suggestion.expected_amount_cents,
    anchor_month: suggestion.anchor_month,
    anchor_phase: suggestion.anchor_phase,
  });
}
