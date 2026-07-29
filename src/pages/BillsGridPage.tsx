import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DatabaseLockedError,
  ForeignKeyViolationError,
  ValidationError,
  createManualPayment,
  deletePayment,
  getBillPayGridForYear,
  updateManualPayment,
  resolvePayeeDefaults,
  type BillPayGrid,
  type BillPayGridCellPayment,
  type Repositories,
} from "../core";

interface BillsGridPageProps {
  repos: Repositories;
  initialYear?: number;
}

interface CellEditorState {
  date: string;
  amountText: string;
  memo: string;
}

interface SelectedCell {
  payeeId: number;
  month: number;
}

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function toUiErrorMessage(error: unknown): string {
  if (error instanceof ValidationError) return error.message;
  if (error instanceof ForeignKeyViolationError) {
    return "A selected payee, account, or category is no longer available. Refresh and try again.";
  }
  if (error instanceof DatabaseLockedError) {
    return "Database is locked by another app or window. Close other database users and try again.";
  }
  return error instanceof Error ? error.message : String(error);
}

function toAmountText(amountCents: number): string {
  const sign = amountCents < 0 ? "-" : "";
  const abs = Math.abs(amountCents);
  const dollars = Math.floor(abs / 100);
  const cents = (abs % 100).toString().padStart(2, "0");
  return `${sign}${dollars}.${cents}`;
}

function toCurrency(amountCents: number): string {
  const sign = amountCents < 0 ? "-" : "";
  const abs = Math.abs(amountCents);
  const dollars = Math.floor(abs / 100);
  const cents = (abs % 100).toString().padStart(2, "0");
  return `${sign}$${dollars}.${cents}`;
}

function parseCurrencyToCents(input: string): number | null {
  const normalized = input.trim().replace(/[$,\s]/g, "");
  if (normalized.length === 0) return null;

  const match = normalized.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;

  const sign = match[1] === "-" ? -1 : 1;
  const dollars = Number.parseInt(match[2], 10);
  const centsRaw = match[3] ?? "";
  const cents = Number.parseInt(centsRaw.padEnd(2, "0") || "0", 10);

  if (!Number.isInteger(dollars) || !Number.isInteger(cents)) return null;
  return sign * (dollars * 100 + cents);
}

function formatCellEntry(payment: BillPayGridCellPayment): string {
  const month = payment.date.slice(5, 7);
  const day = payment.date.slice(8, 10);
  return `${month}/${day} ${toCurrency(payment.amount_cents)}`;
}

function makeNewPaymentState(year: number, month: number): CellEditorState {
  return {
    date: `${year}-${String(month).padStart(2, "0")}-01`,
    amountText: "",
    memo: "",
  };
}

export function BillsGridPage({ repos, initialYear }: BillsGridPageProps) {
  const [year, setYear] = useState<number>(initialYear ?? new Date().getFullYear());
  const [loadState, setLoadState] = useState<"loading" | "idle">("loading");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [grid, setGrid] = useState<BillPayGrid | null>(null);
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [newPaymentState, setNewPaymentState] = useState<CellEditorState>(makeNewPaymentState(year, 1));

  const [editingPaymentId, setEditingPaymentId] = useState<number | null>(null);
  const [editPaymentState, setEditPaymentState] = useState<CellEditorState | null>(null);

  const refreshGrid = useCallback(async () => {
    setLoadState("loading");
    try {
      const nextGrid = await getBillPayGridForYear(repos, year);
      setGrid(nextGrid);
      setError(null);
    } catch (e) {
      setGrid(null);
      setError(toUiErrorMessage(e));
    } finally {
      setLoadState("idle");
    }
  }, [repos, year]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      void refreshGrid();
    }, 0);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [refreshGrid]);

  const selectedRow = useMemo(() => {
    if (!grid || !selectedCell) return null;
    return grid.rows.find((row) => row.payee_id === selectedCell.payeeId) ?? null;
  }, [grid, selectedCell]);

  const selectedMonthCell = useMemo(() => {
    if (!selectedRow || !selectedCell) return null;
    return selectedRow.cells[selectedCell.month - 1] ?? null;
  }, [selectedRow, selectedCell]);

  function selectCell(payeeId: number, month: number) {
    setSelectedCell({ payeeId, month });
    setEditingPaymentId(null);
    setEditPaymentState(null);
    setNewPaymentState(makeNewPaymentState(year, month));
    setError(null);
    setStatus(null);
  }

  async function handleAddPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCell) return;

    const amountCents = parseCurrencyToCents(newPaymentState.amountText);
    if (amountCents === null) {
      setError("Enter amount as currency (for example: 45.67).");
      return;
    }

    try {
      const defaults = await resolvePayeeDefaults(repos, selectedCell.payeeId);
      if (defaults.account_id === null) {
        setError("Set a default account for this payee before adding from a grid cell.");
        return;
      }

      await createManualPayment(repos, {
        payee_id: defaults.payee_id,
        account_id: defaults.account_id,
        category_id: defaults.category_id,
        date: newPaymentState.date,
        amount_cents: amountCents,
        memo: newPaymentState.memo,
      });

      setStatus("Payment saved.");
      setNewPaymentState(makeNewPaymentState(year, selectedCell.month));
      await refreshGrid();
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  function beginEdit(payment: BillPayGridCellPayment) {
    setEditingPaymentId(payment.id);
    setEditPaymentState({
      date: payment.date,
      amountText: toAmountText(payment.amount_cents),
      memo: payment.memo ?? "",
    });
    setError(null);
    setStatus(null);
  }

  async function handleSaveEdit(event: FormEvent<HTMLFormElement>, payment: BillPayGridCellPayment) {
    event.preventDefault();
    if (!editPaymentState) return;

    const amountCents = parseCurrencyToCents(editPaymentState.amountText);
    if (amountCents === null) {
      setError("Enter amount as currency (for example: 45.67).");
      return;
    }

    try {
      const updated = await updateManualPayment(repos, payment.id, {
        payee_id: payment.payee_id,
        account_id: payment.account_id,
        category_id: payment.category_id,
        date: editPaymentState.date,
        amount_cents: amountCents,
        memo: editPaymentState.memo,
      });
      if (!updated) {
        setError("Payment no longer exists. Refresh and try again.");
        return;
      }
      setStatus("Payment updated.");
      setEditingPaymentId(null);
      setEditPaymentState(null);
      await refreshGrid();
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  async function handleDelete(paymentId: number) {
    try {
      const deleted = await deletePayment(repos, paymentId);
      if (!deleted) {
        setError("Payment no longer exists. Refresh and try again.");
        return;
      }
      setStatus("Payment deleted.");
      if (editingPaymentId === paymentId) {
        setEditingPaymentId(null);
        setEditPaymentState(null);
      }
      await refreshGrid();
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  return (
    <section className="page bills-grid-page">
      <header className="payments-header">
        <div>
          <h1>Bills Grid</h1>
          <p className="muted">Payees by month for one year, with row and month totals.</p>
        </div>
        <div className="year-switcher" aria-label="Year switcher">
          <button
            type="button"
            onClick={() => {
              setYear((current) => current - 1);
              setSelectedCell(null);
            }}
          >
            Previous year
          </button>
          <input
            aria-label="Grid year"
            inputMode="numeric"
            value={String(year)}
            onChange={(event) => {
              const nextYear = Number.parseInt(event.currentTarget.value, 10);
              if (!Number.isInteger(nextYear)) return;
              setYear(nextYear);
              setSelectedCell(null);
            }}
          />
          <button
            type="button"
            onClick={() => {
              setYear((current) => current + 1);
              setSelectedCell(null);
            }}
          >
            Next year
          </button>
        </div>
      </header>

      {status && <p className="status">{status}</p>}
      {error && <p className="error">{error}</p>}
      {loadState === "loading" && <p className="muted">Loading bills grid…</p>}

      {loadState === "idle" && error && (
        <button type="button" onClick={() => void refreshGrid()}>
          Retry
        </button>
      )}

      {loadState === "idle" && !error && grid && grid.rows.length === 0 && (
        <p className="muted">No payees found for this year. Add payees to start tracking payments.</p>
      )}

      {loadState === "idle" && !error && grid && grid.rows.length > 0 && (
        <table className="entity-table bills-grid-table">
          <thead>
            <tr>
              <th>Payee</th>
              {MONTH_NAMES_SHORT.map((monthName) => (
                <th key={monthName}>{monthName}</th>
              ))}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.payee_id}>
                <th scope="row">{row.payee_name}</th>
                {row.cells.map((cell) => (
                  <td key={cell.month}>
                    <button
                      type="button"
                      className="grid-cell-trigger"
                      onClick={() => selectCell(row.payee_id, cell.month)}
                      aria-label={`Open ${row.payee_name} ${MONTH_NAMES_LONG[cell.month - 1]} ${grid.year}`}
                    >
                      {cell.payments.length === 0 ? (
                        <span className="muted">-</span>
                      ) : (
                        cell.payments.map((payment) => (
                          <span key={payment.id} className="grid-cell-line">
                            {formatCellEntry(payment)}
                          </span>
                        ))
                      )}
                    </button>
                  </td>
                ))}
                <td className="amount-cell">{toCurrency(row.row_total_cents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {grid.month_totals.map((month) => (
                <td key={month.month} className="amount-cell">
                  {toCurrency(month.total_cents)}
                </td>
              ))}
              <td className="amount-cell">{toCurrency(grid.grand_total_cents)}</td>
            </tr>
          </tfoot>
        </table>
      )}

      {selectedCell && selectedRow && selectedMonthCell && (
        <section className="grid-cell-panel" aria-label="Grid cell context">
          <h2>
            {selectedRow.payee_name} - {MONTH_NAMES_LONG[selectedCell.month - 1]} {year}
          </h2>

          {selectedMonthCell.payments.length === 0 && (
            <p className="muted">No payments in this cell yet. Add one below.</p>
          )}

          {selectedMonthCell.payments.length > 0 && (
            <ul className="grid-cell-payments-list">
              {selectedMonthCell.payments.map((payment) => {
                const label = formatCellEntry(payment);
                const isEditing = editingPaymentId === payment.id && editPaymentState !== null;

                return (
                  <li key={payment.id}>
                    {isEditing ? (
                      <form
                        className="grid-cell-edit-form"
                        onSubmit={(event) => void handleSaveEdit(event, payment)}
                      >
                        <label className="field">
                          Date
                          <input
                            type="date"
                            value={editPaymentState.date}
                            onChange={(event) => {
                              const { value } = event.currentTarget;
                              setEditPaymentState((current) =>
                                current ? { ...current, date: value } : current,
                              );
                            }}
                          />
                        </label>
                        <label className="field">
                          Amount
                          <input
                            value={editPaymentState.amountText}
                            inputMode="decimal"
                            onChange={(event) => {
                              const { value } = event.currentTarget;
                              setEditPaymentState((current) =>
                                current ? { ...current, amountText: value } : current,
                              );
                            }}
                          />
                        </label>
                        <label className="field">
                          Memo
                          <input
                            value={editPaymentState.memo}
                            onChange={(event) => {
                              const { value } = event.currentTarget;
                              setEditPaymentState((current) =>
                                current ? { ...current, memo: value } : current,
                              );
                            }}
                          />
                        </label>
                        <div className="entity-actions-cell">
                          <button type="submit" className="primary">
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingPaymentId(null);
                              setEditPaymentState(null);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="grid-cell-payment-row">
                        <span>{label}</span>
                        <div className="entity-actions-cell">
                          <button type="button" onClick={() => beginEdit(payment)}>
                            Edit
                          </button>
                          <button type="button" onClick={() => void handleDelete(payment.id)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <form className="grid-cell-add-form" onSubmit={(event) => void handleAddPayment(event)}>
            <h3>Add payment</h3>
            <label className="field">
              Date
              <input
                type="date"
                value={newPaymentState.date}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setNewPaymentState((current) => ({ ...current, date: value }));
                }}
              />
            </label>
            <label className="field">
              Amount
              <input
                value={newPaymentState.amountText}
                inputMode="decimal"
                placeholder="0.00"
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setNewPaymentState((current) => ({ ...current, amountText: value }));
                }}
              />
            </label>
            <label className="field">
              Memo (optional)
              <input
                value={newPaymentState.memo}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setNewPaymentState((current) => ({ ...current, memo: value }));
                }}
              />
            </label>
            <div className="entity-actions-cell">
              <button type="submit" className="primary">
                Add payment
              </button>
            </div>
          </form>
        </section>
      )}
    </section>
  );
}
