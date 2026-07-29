import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  DatabaseLockedError,
  ForeignKeyViolationError,
  ValidationError,
  buildQuickAddDraft,
  createManualPayment,
  deletePayment,
  formatLocalIsoDate,
  resolvePayeeDefaults,
  updateManualPayment,
  type Account,
  type Category,
  type Payment,
  type Payee,
  type Repositories,
} from "../core";

interface PaymentsPageProps {
  repos: Repositories;
}

interface PaymentFormState {
  payeeId: string;
  accountId: string;
  categoryId: string;
  date: string;
  amountText: string;
  memo: string;
}

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

function centsToAmountInput(amountCents: number): string {
  const sign = amountCents < 0 ? "-" : "";
  const abs = Math.abs(amountCents);
  const dollars = Math.floor(abs / 100);
  const cents = (abs % 100).toString().padStart(2, "0");
  return `${sign}${dollars}.${cents}`;
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

function toSelectId(value: number | null): string {
  return value === null ? "" : String(value);
}

function buildEntityNameMap<T extends { id: number; name: string }>(items: T[]): Map<number, string> {
  const pairs = items.map((item) => [item.id, item.name] as const);
  return new Map<number, string>(pairs);
}

function dateWindowForCurrentYear(now: Date): { from: string; to: string } {
  const year = now.getFullYear();
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function makeCreateForm(now: Date): PaymentFormState {
  return {
    payeeId: "",
    accountId: "",
    categoryId: "",
    date: formatLocalIsoDate(now),
    amountText: "",
    memo: "",
  };
}

export function PaymentsPage({ repos }: PaymentsPageProps) {
  const [loadState, setLoadState] = useState<"loading" | "idle">("loading");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [payees, setPayees] = useState<Payee[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingPaymentId, setEditingPaymentId] = useState<number | null>(null);
  const [formState, setFormState] = useState<PaymentFormState>(makeCreateForm(new Date()));

  const payeeSelectRef = useRef<HTMLSelectElement | null>(null);

  const payeeNameById = useMemo(() => buildEntityNameMap(payees), [payees]);
  const accountNameById = useMemo(() => buildEntityNameMap(accounts), [accounts]);
  const categoryNameById = useMemo(() => buildEntityNameMap(categories), [categories]);

  const activePayees = useMemo(() => payees.filter((payee) => !payee.archived), [payees]);
  const activeAccounts = useMemo(() => accounts.filter((account) => !account.archived), [accounts]);
  const activeCategories = useMemo(
    () => categories.filter((category) => !category.archived),
    [categories],
  );

  const isEditing = editingPaymentId !== null;

  const reloadAll = useCallback(async () => {
    setLoadState("loading");
    try {
      const window = dateWindowForCurrentYear(new Date());
      const [nextPayees, nextAccounts, nextCategories, nextPayments] = await Promise.all([
        repos.payees.list({ includeArchived: true }),
        repos.accounts.list({ includeArchived: true }),
        repos.categories.list({ includeArchived: true }),
        repos.payments.list(window),
      ]);
      setPayees(nextPayees);
      setAccounts(nextAccounts);
      setCategories(nextCategories);
      setPayments(nextPayments);
    } catch (e) {
      setError(toUiErrorMessage(e));
    } finally {
      setLoadState("idle");
    }
  }, [repos]);

  const handleOpenQuickAdd = useCallback(async () => {
    setError(null);
    setStatus(null);
    setEditingPaymentId(null);

    const firstPayee = activePayees[0] ?? null;
    if (!firstPayee) {
      setFormState(makeCreateForm(new Date()));
      setIsFormOpen(true);
      return;
    }

    try {
      const draft = await buildQuickAddDraft(repos, firstPayee.id);
      setFormState({
        payeeId: String(draft.payee_id ?? ""),
        accountId: toSelectId(draft.account_id),
        categoryId: toSelectId(draft.category_id),
        date: draft.date,
        amountText: "",
        memo: draft.memo,
      });
      setIsFormOpen(true);
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }, [activePayees, repos]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await reloadAll();
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadAll]);

  useEffect(() => {
    if (!isFormOpen) return;
    payeeSelectRef.current?.focus();
  }, [isFormOpen, editingPaymentId]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;

      if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (isTypingTarget) return;
        event.preventDefault();
        setError(null);
        setStatus(null);
        void handleOpenQuickAdd();
        return;
      }

      if (event.key === "Escape" && isFormOpen) {
        event.preventDefault();
        setIsFormOpen(false);
        setEditingPaymentId(null);
      }
    };

    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, [handleOpenQuickAdd, isFormOpen]);

  async function handlePayeeChange(payeeIdText: string) {
    setError(null);
    const payeeId = Number.parseInt(payeeIdText, 10);
    if (!Number.isInteger(payeeId)) {
      setFormState((current) => ({ ...current, payeeId: "", accountId: "", categoryId: "" }));
      return;
    }

    try {
      const defaults = await resolvePayeeDefaults(repos, payeeId);
      setFormState((current) => ({
        ...current,
        payeeId: String(defaults.payee_id),
        accountId: toSelectId(defaults.account_id),
        categoryId: toSelectId(defaults.category_id),
      }));
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  function prepareEdit(payment: Payment) {
    setError(null);
    setStatus(null);
    setEditingPaymentId(payment.id);
    setFormState({
      payeeId: String(payment.payee_id),
      accountId: String(payment.account_id),
      categoryId: toSelectId(payment.category_id),
      date: payment.date,
      amountText: centsToAmountInput(payment.amount_cents),
      memo: payment.memo ?? "",
    });
    setIsFormOpen(true);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus(null);

    const payeeId = Number.parseInt(formState.payeeId, 10);
    const accountId = Number.parseInt(formState.accountId, 10);
    const categoryId = formState.categoryId === "" ? null : Number.parseInt(formState.categoryId, 10);
    const amountCents = parseCurrencyToCents(formState.amountText);

    if (amountCents === null) {
      setError("Enter amount as currency (for example: 45.67).");
      return;
    }

    try {
      if (isEditing && editingPaymentId !== null) {
        const updated = await updateManualPayment(repos, editingPaymentId, {
          payee_id: payeeId,
          account_id: accountId,
          category_id: categoryId,
          date: formState.date,
          amount_cents: amountCents,
          memo: formState.memo,
        });
        if (!updated) {
          setError("Payment no longer exists. Refresh and try again.");
          return;
        }
        setStatus("Payment updated.");
      } else {
        await createManualPayment(repos, {
          payee_id: payeeId,
          account_id: accountId,
          category_id: categoryId,
          date: formState.date,
          amount_cents: amountCents,
          memo: formState.memo,
        });
        setStatus("Payment saved.");
      }

      await reloadAll();
      setIsFormOpen(false);
      setEditingPaymentId(null);
      setFormState(makeCreateForm(new Date()));
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  async function handleDelete(payment: Payment) {
    setError(null);
    setStatus(null);
    try {
      const deleted = await deletePayment(repos, payment.id);
      if (!deleted) {
        setError("Payment no longer exists. Refresh and try again.");
        return;
      }
      setStatus("Payment deleted.");
      await reloadAll();
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  return (
    <section className="page payments-page">
      <header className="payments-header">
        <div>
          <h1>Payments</h1>
          <p className="muted">Record and edit bill payments quickly. Press N to quick-add.</p>
        </div>
        <button type="button" className="primary" onClick={() => void handleOpenQuickAdd()}>
          Quick add (N)
        </button>
      </header>

      {status && <p className="status">{status}</p>}
      {error && <p className="error">{error}</p>}
      {loadState === "loading" && <p className="muted">Refreshing payments…</p>}

      {isFormOpen && (
        <form className="payment-form" onSubmit={(event) => void handleSubmit(event)}>
          <label className="field">
            Payee
            <select
              ref={payeeSelectRef}
              value={formState.payeeId}
              onChange={(event) => {
                const { value } = event.currentTarget;
                void handlePayeeChange(value);
              }}
            >
              <option value="">Select payee</option>
              {activePayees.map((payee) => (
                <option key={payee.id} value={payee.id}>
                  {payee.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Account
            <select
              value={formState.accountId}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setFormState((current) => ({ ...current, accountId: value }));
              }}
            >
              <option value="">Select account</option>
              {activeAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Category
            <select
              value={formState.categoryId}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setFormState((current) => ({ ...current, categoryId: value }));
              }}
            >
              <option value="">(none)</option>
              {activeCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Date
            <input
              type="date"
              value={formState.date}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setFormState((current) => ({ ...current, date: value }));
              }}
            />
          </label>

          <label className="field">
            Amount
            <input
              value={formState.amountText}
              inputMode="decimal"
              placeholder="0.00"
              onChange={(event) => {
                const { value } = event.currentTarget;
                setFormState((current) => ({ ...current, amountText: value }));
              }}
            />
          </label>

          <label className="field">
            Memo (optional)
            <input
              value={formState.memo}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setFormState((current) => ({ ...current, memo: value }));
              }}
            />
          </label>

          <div className="payment-form-actions">
            <button type="submit" className="primary">
              {isEditing ? "Save payment" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsFormOpen(false);
                setEditingPaymentId(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <table className="entity-table payments-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Payee</th>
            <th>Account</th>
            <th>Category</th>
            <th>Amount</th>
            <th>Memo</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {payments.length === 0 ? (
            <tr>
              <td colSpan={7} className="muted">
                No payments in this year yet.
              </td>
            </tr>
          ) : (
            payments.map((payment) => {
              const payeeName = payeeNameById.get(payment.payee_id) ?? "(missing payee)";
              const accountName = accountNameById.get(payment.account_id) ?? "(missing account)";
              const categoryName =
                payment.category_id === null
                  ? "-"
                  : (categoryNameById.get(payment.category_id) ?? "(missing category)");

              return (
                <tr key={payment.id}>
                  <td>{payment.date}</td>
                  <td>{payeeName}</td>
                  <td>{accountName}</td>
                  <td>{categoryName}</td>
                  <td>{centsToAmountInput(payment.amount_cents)}</td>
                  <td>{payment.memo ?? ""}</td>
                  <td className="entity-actions-cell">
                    <button type="button" onClick={() => prepareEdit(payment)}>
                      Edit
                    </button>
                    <button type="button" onClick={() => void handleDelete(payment)}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </section>
  );
}
