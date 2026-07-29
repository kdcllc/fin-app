import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DatabaseLockedError,
  ForeignKeyViolationError,
  ValidationError,
  dismissRecurringBillSuggestion,
  getRecurringBillSuggestions,
  getRecurringDashboardMonth,
  type BillFrequency,
  type RecurringBill,
  type RecurringBillSuggestion,
  type RecurringDashboardMonth,
  type Repositories,
} from "../core";

interface DashboardPageProps {
  repos: Repositories;
  initialYear?: number;
  initialMonth?: number;
}

interface RecurringFormState {
  payeeIdText: string;
  frequency: BillFrequency;
  dueDayText: string;
  expectedAmountText: string;
}

interface SuggestionDraft {
  frequency: BillFrequency;
  dueDayText: string;
  expectedAmountText: string;
}

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
    return "A selected payee is no longer available. Refresh and try again.";
  }
  if (error instanceof DatabaseLockedError) {
    return "Database is locked by another app or window. Close other database users and try again.";
  }
  return error instanceof Error ? error.message : String(error);
}

function toAmountText(amountCents: number): string {
  const sign = amountCents < 0 ? "-" : "";
  const abs = Math.abs(amountCents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function toCurrency(amountCents: number | null): string {
  if (amountCents === null) return "Variable";
  const sign = amountCents < 0 ? "-" : "";
  const abs = Math.abs(amountCents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
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

function parsePositiveInt(input: string): number | null {
  if (!/^\d+$/.test(input.trim())) return null;
  const parsed = Number.parseInt(input, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function buildRecurringFormFromBill(bill: RecurringBill): RecurringFormState {
  return {
    payeeIdText: String(bill.payee_id),
    frequency: bill.frequency,
    dueDayText: String(bill.due_day),
    expectedAmountText:
      bill.expected_amount_cents === null ? "" : toAmountText(bill.expected_amount_cents),
  };
}

function emptyRecurringForm(): RecurringFormState {
  return {
    payeeIdText: "",
    frequency: "monthly",
    dueDayText: "1",
    expectedAmountText: "",
  };
}

function suggestionKey(suggestion: RecurringBillSuggestion): string {
  return `${suggestion.payee_id}|${suggestion.frequency}|${suggestion.due_day}|${suggestion.expected_amount_cents ?? "null"}|${suggestion.anchor_month}|${suggestion.anchor_phase}`;
}

export function DashboardPage({ repos, initialYear, initialMonth }: DashboardPageProps) {
  const now = new Date();
  const [year, setYear] = useState(initialYear ?? now.getFullYear());
  const [month, setMonth] = useState(initialMonth ?? now.getMonth() + 1);
  const [toleranceText, setToleranceText] = useState("500");

  const [loadState, setLoadState] = useState<"loading" | "idle">("loading");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [dashboard, setDashboard] = useState<RecurringDashboardMonth | null>(null);
  const [recurringBills, setRecurringBills] = useState<RecurringBill[]>([]);
  const [payees, setPayees] = useState<Array<{ id: number; name: string; archived: boolean }>>([]);
  const [suggestions, setSuggestions] = useState<RecurringBillSuggestion[]>([]);

  const [editingRecurringId, setEditingRecurringId] = useState<number | null>(null);
  const [recurringForm, setRecurringForm] = useState<RecurringFormState>(emptyRecurringForm);

  const [editingSuggestionKey, setEditingSuggestionKey] = useState<string | null>(null);
  const [suggestionDrafts, setSuggestionDrafts] = useState<Record<string, SuggestionDraft>>({});

  const activePayees = useMemo(() => payees.filter((payee) => !payee.archived), [payees]);

  const refreshData = useCallback(async () => {
    const toleranceCents = parsePositiveInt(toleranceText);
    if (toleranceCents === null) {
      setError("Tolerance must be a whole number of cents (for example 500). ");
      setLoadState("idle");
      return;
    }

    setLoadState("loading");
    try {
      const [nextDashboard, nextRecurringBills, nextPayees, nextSuggestions] = await Promise.all([
        getRecurringDashboardMonth(repos, { year, month, toleranceCents }),
        repos.recurringBills.list(),
        repos.payees.list({ includeArchived: true }),
        getRecurringBillSuggestions(repos),
      ]);
      setDashboard(nextDashboard);
      setRecurringBills(nextRecurringBills);
      setPayees(nextPayees);
      setSuggestions(nextSuggestions);
      setError(null);
    } catch (e) {
      setDashboard(null);
      setError(toUiErrorMessage(e));
    } finally {
      setLoadState("idle");
    }
  }, [repos, year, month, toleranceText]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      void refreshData();
    }, 0);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [refreshData]);

  async function handleRecurringSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payeeId = parsePositiveInt(recurringForm.payeeIdText);
    const dueDay = parsePositiveInt(recurringForm.dueDayText);
    if (payeeId === null) {
      setError("Choose a payee for the recurring bill.");
      return;
    }
    if (dueDay === null || dueDay < 1 || dueDay > 31) {
      setError("Due day must be from 1 to 31.");
      return;
    }

    const expectedAmountCents =
      recurringForm.expectedAmountText.trim().length === 0
        ? null
        : parseCurrencyToCents(recurringForm.expectedAmountText);
    if (
      recurringForm.expectedAmountText.trim().length > 0 &&
      expectedAmountCents === null
    ) {
      setError("Expected amount must be valid currency (for example 125.00). ");
      return;
    }

    try {
      if (editingRecurringId === null) {
        await repos.recurringBills.insert({
          payee_id: payeeId,
          frequency: recurringForm.frequency,
          due_day: dueDay,
          expected_amount_cents: expectedAmountCents,
        });
        setStatus("Recurring bill created.");
      } else {
        await repos.recurringBills.update(editingRecurringId, {
          payee_id: payeeId,
          frequency: recurringForm.frequency,
          due_day: dueDay,
          expected_amount_cents: expectedAmountCents,
        });
        setStatus("Recurring bill updated.");
      }
      setEditingRecurringId(null);
      setRecurringForm(emptyRecurringForm());
      await refreshData();
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  async function handleDeleteRecurring(id: number) {
    try {
      const deleted = await repos.recurringBills.delete(id);
      if (!deleted) {
        setError("Recurring bill no longer exists. Refresh and try again.");
        return;
      }
      setStatus("Recurring bill deleted.");
      if (editingRecurringId === id) {
        setEditingRecurringId(null);
        setRecurringForm(emptyRecurringForm());
      }
      await refreshData();
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  async function handleToggleRecurringActive(bill: RecurringBill) {
    try {
      await repos.recurringBills.update(bill.id, { active: !bill.active });
      setStatus(bill.active ? "Recurring bill archived." : "Recurring bill re-activated.");
      await refreshData();
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  async function handleAcceptSuggestion(
    suggestion: RecurringBillSuggestion,
    draft?: SuggestionDraft,
  ) {
    const frequency = draft?.frequency ?? suggestion.frequency;
    const dueDay = draft ? parsePositiveInt(draft.dueDayText) : suggestion.due_day;
    if (dueDay === null || dueDay < 1 || dueDay > 31) {
      setError("Suggestion due day must be from 1 to 31.");
      return;
    }

    const expectedAmountCents =
      draft && draft.expectedAmountText.trim().length === 0
        ? null
        : draft
          ? parseCurrencyToCents(draft.expectedAmountText)
          : suggestion.expected_amount_cents;
    if (
      draft &&
      draft.expectedAmountText.trim().length > 0 &&
      expectedAmountCents === null
    ) {
      setError("Suggestion expected amount must be valid currency.");
      return;
    }

    const anchorMonth = frequency === "monthly" ? 1 : suggestion.anchor_month;
    const anchorPhase =
      frequency === "monthly"
        ? 1
        : frequency === "quarterly"
          ? suggestion.anchor_phase
          : ((anchorMonth - 1) % 3) + 1;

    try {
      await repos.recurringBills.insert({
        payee_id: suggestion.payee_id,
        frequency,
        due_day: dueDay,
        expected_amount_cents: expectedAmountCents,
        anchor_month: anchorMonth,
        anchor_phase: anchorPhase,
      });
      setStatus(`Accepted recurring suggestion for ${suggestion.payee_name}.`);
      setEditingSuggestionKey(null);
      await refreshData();
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  async function handleDismissSuggestion(suggestion: RecurringBillSuggestion) {
    try {
      await dismissRecurringBillSuggestion(repos, suggestion);
      setStatus(`Dismissed recurring suggestion for ${suggestion.payee_name}.`);
      await refreshData();
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  return (
    <section className="page dashboard-page">
      <header className="payments-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Due this month, paid, overdue, and recurring bill suggestions.</p>
        </div>
        <div className="dashboard-filters">
          <label className="field">
            Year
            <input
              aria-label="Dashboard year"
              inputMode="numeric"
              value={String(year)}
              onChange={(event) => {
                const next = Number.parseInt(event.currentTarget.value, 10);
                if (!Number.isInteger(next)) return;
                setYear(next);
              }}
            />
          </label>
          <label className="field">
            Month
            <select
              aria-label="Dashboard month"
              value={String(month)}
              onChange={(event) => {
                setMonth(Number.parseInt(event.currentTarget.value, 10));
              }}
            >
              {MONTH_NAMES_LONG.map((name, index) => (
                <option key={name} value={String(index + 1)}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Amount tolerance (cents)
            <input
              aria-label="Amount tolerance"
              inputMode="numeric"
              value={toleranceText}
              onChange={(event) => setToleranceText(event.currentTarget.value)}
            />
          </label>
          <button type="button" onClick={() => void refreshData()}>
            Refresh
          </button>
        </div>
      </header>

      {status && <p className="status">{status}</p>}
      {error && <p className="error">{error}</p>}
      {loadState === "loading" && <p className="muted">Loading dashboard…</p>}

      {loadState === "idle" && error && (
        <button type="button" onClick={() => void refreshData()}>
          Retry
        </button>
      )}

      {loadState === "idle" && !error && dashboard && (
        <>
          <section className="dashboard-kpis" aria-label="Dashboard summary">
            <article className="dashboard-kpi-card">
              <h2>Due</h2>
              <p>{dashboard.due.length}</p>
            </article>
            <article className="dashboard-kpi-card">
              <h2>Paid</h2>
              <p>{dashboard.paid.length}</p>
            </article>
            <article className="dashboard-kpi-card">
              <h2>Overdue</h2>
              <p>{dashboard.overdue.length}</p>
            </article>
            <article className="dashboard-kpi-card">
              <h2>Month to date spent</h2>
              <p>{toCurrency(dashboard.month_to_date_spent_cents)}</p>
            </article>
          </section>

          {dashboard.warnings.length > 0 && (
            <section className="entity-section" aria-label="Dashboard warnings">
              <h2>Warnings</h2>
              <ul>
                {dashboard.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="dashboard-lists" aria-label="Recurring status lists">
            <article className="entity-section">
              <h2>Due this month</h2>
              {dashboard.due.length === 0 ? (
                <p className="muted">No unpaid bills are currently due this month.</p>
              ) : (
                <ul>
                  {dashboard.due.map((item) => (
                    <li key={item.recurring_bill_id}>
                      {item.payee_name} due {item.due_date} ({item.frequency}, expected {toCurrency(item.expected_amount_cents)})
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article className="entity-section">
              <h2>Paid this month</h2>
              {dashboard.paid.length === 0 ? (
                <p className="muted">No recurring bills have been matched yet this month.</p>
              ) : (
                <ul>
                  {dashboard.paid.map((item) => (
                    <li key={item.recurring_bill_id}>
                      {item.payee_name} matched {toCurrency(item.matched_amount_cents)} for due date {item.due_date}
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article className="entity-section">
              <h2>Overdue</h2>
              {dashboard.overdue.length === 0 ? (
                <p className="muted">No overdue recurring bills for this month.</p>
              ) : (
                <ul>
                  {dashboard.overdue.map((item) => (
                    <li key={item.recurring_bill_id}>
                      {item.payee_name} overdue since {item.due_date} ({item.frequency}, expected {toCurrency(item.expected_amount_cents)})
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </section>
        </>
      )}

      <section className="entity-section" aria-label="Manage recurring bills">
        <h2>Manage recurring bills</h2>
        {activePayees.length === 0 && (
          <p className="muted">No active payees found. Create a payee before adding recurring bills.</p>
        )}
        <form className="entity-form" onSubmit={(event) => void handleRecurringSubmit(event)}>
          <label className="field">
            Payee
            <select
              aria-label="Recurring payee"
              value={recurringForm.payeeIdText}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setRecurringForm((current) => ({ ...current, payeeIdText: value }));
              }}
            >
              <option value="">Choose payee</option>
              {activePayees.map((payee) => (
                <option key={payee.id} value={String(payee.id)}>
                  {payee.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Frequency
            <select
              aria-label="Recurring frequency"
              value={recurringForm.frequency}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setRecurringForm((current) => ({
                  ...current,
                  frequency: value as BillFrequency,
                }));
              }}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annual</option>
            </select>
          </label>
          <label className="field">
            Due day
            <input
              aria-label="Recurring due day"
              inputMode="numeric"
              value={recurringForm.dueDayText}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setRecurringForm((current) => ({ ...current, dueDayText: value }));
              }}
            />
          </label>
          <label className="field">
            Expected amount (optional)
            <input
              aria-label="Recurring expected amount"
              placeholder="120.00"
              value={recurringForm.expectedAmountText}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setRecurringForm((current) => ({
                  ...current,
                  expectedAmountText: value,
                }));
              }}
            />
          </label>
          <div className="entity-form-actions">
            <button type="submit" className="primary">
              {editingRecurringId === null ? "Add recurring bill" : "Save recurring bill"}
            </button>
            {editingRecurringId !== null && (
              <button
                type="button"
                onClick={() => {
                  setEditingRecurringId(null);
                  setRecurringForm(emptyRecurringForm());
                }}
              >
                Cancel edit
              </button>
            )}
          </div>
        </form>

        {recurringBills.length === 0 ? (
          <p className="muted">No recurring definitions yet. Add one above or accept a suggestion below.</p>
        ) : (
          <table className="entity-table">
            <thead>
              <tr>
                <th>Payee</th>
                <th>Frequency</th>
                <th>Due day</th>
                <th>Expected amount</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recurringBills.map((bill) => {
                const payee = payees.find((item) => item.id === bill.payee_id);
                return (
                  <tr key={bill.id}>
                    <td>{payee ? payee.name : `Payee ${bill.payee_id}`}</td>
                    <td>{bill.frequency}</td>
                    <td>{bill.due_day}</td>
                    <td>{toCurrency(bill.expected_amount_cents)}</td>
                    <td>{bill.active ? "Active" : "Archived"}</td>
                    <td className="entity-actions-cell">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingRecurringId(bill.id);
                          setRecurringForm(buildRecurringFormFromBill(bill));
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" onClick={() => void handleToggleRecurringActive(bill)}>
                        {bill.active ? "Archive" : "Activate"}
                      </button>
                      <button type="button" onClick={() => void handleDeleteRecurring(bill.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="entity-section" aria-label="Suggested recurring bills">
        <h2>Suggested recurring bills</h2>
        {suggestions.length === 0 ? (
          <p className="muted">No suggestions right now. Import more history or add recurring bills manually.</p>
        ) : (
          <ul className="dashboard-suggestions-list">
            {suggestions.map((suggestion) => {
              const key = suggestionKey(suggestion);
              const draft = suggestionDrafts[key] ?? {
                frequency: suggestion.frequency,
                dueDayText: String(suggestion.due_day),
                expectedAmountText:
                  suggestion.expected_amount_cents === null
                    ? ""
                    : toAmountText(suggestion.expected_amount_cents),
              };
              const isEditing = editingSuggestionKey === key;

              return (
                <li key={key} className="dashboard-suggestion-item">
                  <div>
                    <strong>{suggestion.payee_name}</strong> {suggestion.frequency} suggestion based on {suggestion.sample_payment_count} payments (last {suggestion.last_payment_date}).
                  </div>
                  {isEditing ? (
                    <div className="entity-inline-controls">
                      <label className="field">
                        Frequency
                        <select
                          value={draft.frequency}
                          onChange={(event) => {
                            const { value } = event.currentTarget;
                            setSuggestionDrafts((current) => ({
                              ...current,
                              [key]: { ...draft, frequency: value as BillFrequency },
                            }));
                          }}
                        >
                          <option value="monthly">Monthly</option>
                          <option value="quarterly">Quarterly</option>
                          <option value="annual">Annual</option>
                        </select>
                      </label>
                      <label className="field">
                        Due day
                        <input
                          inputMode="numeric"
                          value={draft.dueDayText}
                          onChange={(event) => {
                            const { value } = event.currentTarget;
                            setSuggestionDrafts((current) => ({
                              ...current,
                              [key]: { ...draft, dueDayText: value },
                            }));
                          }}
                        />
                      </label>
                      <label className="field">
                        Expected amount
                        <input
                          value={draft.expectedAmountText}
                          onChange={(event) => {
                            const { value } = event.currentTarget;
                            setSuggestionDrafts((current) => ({
                              ...current,
                              [key]: { ...draft, expectedAmountText: value },
                            }));
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void handleAcceptSuggestion(suggestion, draft)}
                      >
                        Accept edited
                      </button>
                      <button type="button" onClick={() => setEditingSuggestionKey(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="entity-actions-cell">
                      <span className="muted">
                        due day {suggestion.due_day}, expected {toCurrency(suggestion.expected_amount_cents)}
                      </span>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void handleAcceptSuggestion(suggestion)}
                      >
                        Accept
                      </button>
                      <button type="button" onClick={() => setEditingSuggestionKey(key)}>
                        Edit before accept
                      </button>
                      <button type="button" onClick={() => void handleDismissSuggestion(suggestion)}>
                        Dismiss
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
