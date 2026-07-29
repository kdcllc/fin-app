import type { Repositories } from "./index";

const MONTH_COUNT = 12;

export interface BillPayGridCellPayment {
  id: number;
  payee_id: number;
  account_id: number;
  category_id: number | null;
  date: string;
  amount_cents: number;
  memo: string | null;
}

export interface BillPayGridCell {
  month: number;
  total_cents: number;
  payments: BillPayGridCellPayment[];
}

export interface BillPayGridRow {
  payee_id: number;
  payee_name: string;
  payee_archived: boolean;
  row_total_cents: number;
  cells: BillPayGridCell[];
}

export interface BillPayGridMonthTotal {
  month: number;
  total_cents: number;
}

export interface BillPayGrid {
  year: number;
  rows: BillPayGridRow[];
  month_totals: BillPayGridMonthTotal[];
  grand_total_cents: number;
}

function yearWindow(year: number): { from: string; to: string } {
  return {
    from: `${year.toString().padStart(4, "0")}-01-01`,
    to: `${year.toString().padStart(4, "0")}-12-31`,
  };
}

function getMonthFromIsoDate(date: string): number {
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid payment date for month bucketing: ${date}`);
  }
  return month;
}

function createEmptyCells(): BillPayGridCell[] {
  return Array.from({ length: MONTH_COUNT }, (_, index) => ({
    month: index + 1,
    total_cents: 0,
    payments: [],
  }));
}

export async function getBillPayGridForYear(repos: Repositories, year: number): Promise<BillPayGrid> {
  if (!Number.isInteger(year)) {
    throw new Error("Year must be an integer.");
  }

  const window = yearWindow(year);
  const [payees, payments] = await Promise.all([
    repos.payees.list({ includeArchived: true }),
    repos.payments.list(window),
  ]);

  const payeeById = new Map(payees.map((payee) => [payee.id, payee] as const));
  const inYearPayeeIds = new Set(payments.map((payment) => payment.payee_id));

  const rowPayees = payees
    .filter((payee) => !payee.archived || inYearPayeeIds.has(payee.id))
    .sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      return nameOrder !== 0 ? nameOrder : left.id - right.id;
    });

  const rows: BillPayGridRow[] = rowPayees.map((payee) => ({
    payee_id: payee.id,
    payee_name: payee.name,
    payee_archived: payee.archived,
    row_total_cents: 0,
    cells: createEmptyCells(),
  }));

  const rowByPayeeId = new Map(rows.map((row) => [row.payee_id, row] as const));
  const monthTotals = Array.from({ length: MONTH_COUNT }, (_, index) => ({
    month: index + 1,
    total_cents: 0,
  }));

  for (const payment of payments) {
    if (!payeeById.has(payment.payee_id)) continue;

    const row = rowByPayeeId.get(payment.payee_id);
    if (!row) continue;

    const month = getMonthFromIsoDate(payment.date);
    const cell = row.cells[month - 1];
    const cellPayment: BillPayGridCellPayment = {
      id: payment.id,
      payee_id: payment.payee_id,
      account_id: payment.account_id,
      category_id: payment.category_id,
      date: payment.date,
      amount_cents: payment.amount_cents,
      memo: payment.memo,
    };

    cell.payments.push(cellPayment);
    cell.total_cents += payment.amount_cents;
    row.row_total_cents += payment.amount_cents;
    monthTotals[month - 1].total_cents += payment.amount_cents;
  }

  const grandTotal = monthTotals.reduce((sum, month) => sum + month.total_cents, 0);

  return {
    year,
    rows,
    month_totals: monthTotals,
    grand_total_cents: grandTotal,
  };
}