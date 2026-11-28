/**
 * Register page: one account's transactions with a running balance, a split
 * editor for balanced multi-split transactions, and Transfer / Income quick
 * forms. Data access goes through `repos` and the core public entry only.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DatabaseLockedError,
  ForeignKeyViolationError,
  ReconciledTransactionError,
  UnbalancedTransactionError,
  ValidationError,
  createIncome,
  createTransfer,
  deleteTransaction,
  formatLocalIsoDate,
  getRegister,
  naturalBalance,
  postTransaction,
  updateTransaction,
  type LedgerAccount,
  type Payee,
  type ReconcileState,
  type RegisterRow,
  type Repositories,
} from "../core";
import { formatReportDollars } from "./report-charts";

export interface RegisterPageProps {
  repos: Repositories;
  /** Account to show first; a missing or placeholder id falls back to the first funding account. */
  initialAccountId?: number;
}

interface SplitDraft {
  key: number;
  accountId: string;
  /** Signed dollars text, debit-positive (credit is negative). */
  amount: string;
  memo: string;
  reconcileState: ReconcileState;
}

interface EditorState {
  /** `null` while adding a new transaction. */
  transactionId: number | null;
  date: string;
  payeeId: string;
  memo: string;
  splits: SplitDraft[];
}

function toUiErrorMessage(error: unknown): string {
  if (error instanceof DatabaseLockedError) {
    return "Database is locked by another program — most likely an external SQLite tool has this book file open. Close it, then try again.";
  }
  if (
    error instanceof ValidationError ||
    error instanceof ForeignKeyViolationError ||
    error instanceof UnbalancedTransactionError ||
    error instanceof ReconciledTransactionError
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Same rules as `parseCurrencyToCents` in AccountsPage.tsx (duplicated: that one is module-private). */
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
  const total = sign * (dollars * 100 + cents);
  return Number.isSafeInteger(total) ? total : null;
}

/** Integer cents to an editable decimal string, using integer arithmetic only. */
function centsToInput(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${whole}.${frac}`;
}

function accountPath(account: LedgerAccount, byId: Map<number, LedgerAccount>): string {
  const names: string[] = [];
  const seen = new Set<number>();
  let current: LedgerAccount | undefined = account;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parent_id === null ? undefined : byId.get(current.parent_id);
  }
  return names.join(" : ");
}

function isFunding(account: LedgerAccount): boolean {
  return account.type === "ASSET" || account.type === "LIABILITY";
}

let nextSplitKey = 1;
function blankSplit(accountId = ""): SplitDraft {
  return { key: nextSplitKey++, accountId, amount: "", memo: "", reconcileState: "n" };
}

export function RegisterPage({ repos, initialAccountId }: RegisterPageProps) {
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [choice, setChoice] = useState<number | null>(null);
  const [prevInitial, setPrevInitial] = useState(initialAccountId);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const [transferFrom, setTransferFrom] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferDate, setTransferDate] = useState(() => formatLocalIsoDate(new Date()));
  const [transferMemo, setTransferMemo] = useState("");

  const [incomeAccount, setIncomeAccount] = useState("");
  const [incomeDeposit, setIncomeDeposit] = useState("");
  const [incomeAmount, setIncomeAmount] = useState("");
  const [incomeDate, setIncomeDate] = useState(() => formatLocalIsoDate(new Date()));
  const [incomePayee, setIncomePayee] = useState("");
  const [incomeMemo, setIncomeMemo] = useState("");

  if (prevInitial !== initialAccountId) {
    setPrevInitial(initialAccountId);
    setChoice(null);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nextAccounts, nextPayees] = await Promise.all([
          repos.ledger.listAccounts(),
          repos.payees.list({ includeArchived: true }),
        ]);
        if (cancelled) return;
        setAccounts(nextAccounts);
        setPayees(nextPayees);
      } catch (e) {
        if (!cancelled) setError(toUiErrorMessage(e));
      } finally {
        if (!cancelled) setAccountsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repos, refresh]);

  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const payeesById = useMemo(() => new Map(payees.map((p) => [p.id, p])), [payees]);
  const postable = useMemo(() => accounts.filter((a) => !a.placeholder), [accounts]);
  const activePostable = useMemo(() => postable.filter((a) => !a.archived), [postable]);

  const selectedAccount = useMemo(() => {
    const wanted = choice ?? initialAccountId;
    const direct = wanted === undefined ? undefined : accountsById.get(wanted);
    if (direct !== undefined && !direct.placeholder) return direct;
    return (
      postable.find((a) => isFunding(a) && !a.archived) ??
      postable.find(isFunding) ??
      postable[0] ??
      null
    );
  }, [choice, initialAccountId, accountsById, postable]);
  const selectedId = selectedAccount?.id ?? null;
  const selectedType = selectedAccount?.type ?? null;

  useEffect(() => {
    if (selectedId === null) return; // no register table is shown without an account
    let cancelled = false;
    (async () => {
      try {
        const next = await getRegister(repos.ledger, selectedId, {
          ...(from !== "" ? { from } : {}),
          ...(to !== "" ? { to } : {}),
        });
        if (cancelled) return;
        setRows(next);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(toUiErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repos, selectedId, from, to, refresh]);

  const draftCents = useMemo(() => {
    if (editor === null) return { total: 0, invalid: false };
    let total = 0;
    let invalid = false;
    for (const split of editor.splits) {
      if (split.amount.trim() === "") continue;
      const cents = parseCurrencyToCents(split.amount);
      if (cents === null) invalid = true;
      else total += cents;
    }
    return { total, invalid };
  }, [editor]);
  const canSave = editor !== null && !draftCents.invalid && draftCents.total === 0;

  function accountLabel(account: LedgerAccount): string {
    return `${accountPath(account, accountsById)}${account.archived ? " (archived)" : ""}`;
  }

  function clearMessages() {
    setError(null);
    setStatus(null);
    setEditorError(null);
  }

  function openNewEditor() {
    clearMessages();
    setDeleteConfirmId(null);
    setEditor({
      transactionId: null,
      date: formatLocalIsoDate(new Date()),
      payeeId: "",
      memo: "",
      splits: [blankSplit(selectedId === null ? "" : String(selectedId)), blankSplit()],
    });
  }

  function openEditEditor(row: RegisterRow) {
    clearMessages();
    setDeleteConfirmId(null);
    const tx = row.transaction;
    setEditor({
      transactionId: tx.id,
      date: tx.date,
      payeeId: tx.payee_id === null ? "" : String(tx.payee_id),
      memo: tx.memo ?? "",
      splits: tx.splits.map((split) => ({
        key: nextSplitKey++,
        accountId: String(split.account_id),
        amount: centsToInput(split.amount_cents),
        memo: split.memo ?? "",
        reconcileState: split.reconcile_state,
      })),
    });
  }

  function closeEditor() {
    setEditor(null);
    setEditorError(null);
  }

  function updateSplit(key: number, patch: Partial<SplitDraft>) {
    setEditor((current) =>
      current === null
        ? current
        : {
            ...current,
            splits: current.splits.map((split) =>
              split.key === key ? { ...split, ...patch } : split,
            ),
          },
    );
  }

  async function handleSaveTransaction(event: FormEvent) {
    event.preventDefault();
    if (editor === null || !canSave) return;
    setEditorError(null);
    setStatus(null);

    const splits = [];
    for (const split of editor.splits) {
      if (split.accountId === "") {
        setEditorError("Choose an account for every split.");
        return;
      }
      splits.push({
        account_id: Number(split.accountId),
        amount_cents: parseCurrencyToCents(split.amount) ?? 0,
        memo: split.memo.trim() === "" ? null : split.memo.trim(),
        reconcile_state: split.reconcileState,
      });
    }
    const input = {
      date: editor.date,
      payee_id: editor.payeeId === "" ? null : Number(editor.payeeId),
      memo: editor.memo.trim() === "" ? null : editor.memo.trim(),
      splits,
    };
    try {
      if (editor.transactionId === null) {
        await postTransaction(repos.ledger, input);
        setStatus("Transaction added.");
      } else {
        const stored = await updateTransaction(repos.ledger, editor.transactionId, input);
        if (stored === null) {
          setEditorError("That transaction no longer exists.");
          return;
        }
        setStatus("Transaction updated.");
      }
      closeEditor();
      setRefresh((n) => n + 1);
    } catch (e) {
      setEditorError(toUiErrorMessage(e));
    }
  }

  async function handleConfirmDelete(transactionId: number) {
    clearMessages();
    try {
      await deleteTransaction(repos.ledger, transactionId);
      setDeleteConfirmId(null);
      setStatus("Transaction deleted.");
      setRefresh((n) => n + 1);
    } catch (e) {
      setDeleteConfirmId(null);
      setError(toUiErrorMessage(e));
    }
  }

  async function handleTransfer(event: FormEvent) {
    event.preventDefault();
    clearMessages();
    if (transferFrom === "" || transferTo === "") {
      setError("Choose both a from and a to account for the transfer.");
      return;
    }
    const cents = parseCurrencyToCents(transferAmount);
    if (cents === null) {
      setError("Enter the transfer amount as a dollar amount such as 1234.56.");
      return;
    }
    try {
      await createTransfer(repos.ledger, {
        date: transferDate,
        fromAccountId: Number(transferFrom),
        toAccountId: Number(transferTo),
        amount_cents: cents,
        memo: transferMemo.trim() === "" ? null : transferMemo.trim(),
      });
      setStatus(`Transferred ${formatReportDollars(cents)}.`);
      setTransferAmount("");
      setTransferMemo("");
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  async function handleIncome(event: FormEvent) {
    event.preventDefault();
    clearMessages();
    if (incomeAccount === "" || incomeDeposit === "") {
      setError("Choose both an income account and a deposit account.");
      return;
    }
    const cents = parseCurrencyToCents(incomeAmount);
    if (cents === null) {
      setError("Enter the income amount as a dollar amount such as 1234.56.");
      return;
    }
    try {
      await createIncome(repos.ledger, {
        date: incomeDate,
        incomeAccountId: Number(incomeAccount),
        depositAccountId: Number(incomeDeposit),
        amount_cents: cents,
        payee_id: incomePayee === "" ? null : Number(incomePayee),
        memo: incomeMemo.trim() === "" ? null : incomeMemo.trim(),
      });
      setStatus(`Recorded income of ${formatReportDollars(cents)}.`);
      setIncomeAmount("");
      setIncomeMemo("");
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  const incomeChoices = activePostable.filter((a) => a.type === "INCOME");
  const depositChoices = activePostable.filter(isFunding);

  return (
    <section className="page">
      <h1>Register</h1>
      <p className="muted">Account register with running balance.</p>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status !== null && <p role="status">{status}</p>}

      <div className="toolbar">
        <label>
          Register account{" "}
          <select
            value={selectedId === null ? "" : String(selectedId)}
            onChange={(e) => {
              setChoice(Number(e.target.value));
              setDeleteConfirmId(null);
            }}
          >
            {selectedId === null && <option value="">No accounts</option>}
            {postable.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          From date <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>{" "}
        <label>
          To date <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>{" "}
        <button type="button" onClick={openNewEditor} disabled={selectedId === null}>
          Add transaction
        </button>
      </div>

      {editor !== null && (
        <form onSubmit={handleSaveTransaction} aria-label="Transaction form">
          <h2>{editor.transactionId === null ? "Add transaction" : "Edit transaction"}</h2>
          {editorError !== null && (
            <p className="error" role="alert" data-testid="editor-error">
              {editorError}
            </p>
          )}
          <label>
            Transaction date{" "}
            <input
              type="date"
              value={editor.date}
              onChange={(e) => setEditor({ ...editor, date: e.target.value })}
            />
          </label>{" "}
          <label>
            Transaction payee{" "}
            <select
              value={editor.payeeId}
              onChange={(e) => setEditor({ ...editor, payeeId: e.target.value })}
            >
              <option value="">None</option>
              {payees
                .filter((p) => !p.archived || String(p.id) === editor.payeeId)
                .map((payee) => (
                  <option key={payee.id} value={payee.id}>
                    {payee.name}
                  </option>
                ))}
            </select>
          </label>{" "}
          <label>
            Transaction memo{" "}
            <input
              type="text"
              value={editor.memo}
              onChange={(e) => setEditor({ ...editor, memo: e.target.value })}
            />
          </label>
          <table>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Amount (debit +, credit −)</th>
                <th scope="col">Memo</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {editor.splits.map((split, index) => (
                <tr key={split.key}>
                  <td>
                    <select
                      aria-label={`Split ${index + 1} account`}
                      value={split.accountId}
                      onChange={(e) => updateSplit(split.key, { accountId: e.target.value })}
                    >
                      <option value="">Select an account…</option>
                      {postable.map((account) => (
                        <option key={account.id} value={account.id}>
                          {accountLabel(account)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`Split ${index + 1} amount`}
                      value={split.amount}
                      onChange={(e) => updateSplit(split.key, { amount: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`Split ${index + 1} memo`}
                      value={split.memo}
                      onChange={(e) => updateSplit(split.key, { memo: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      aria-label={`Remove split ${index + 1}`}
                      disabled={editor.splits.length <= 2}
                      onClick={() =>
                        setEditor({
                          ...editor,
                          splits: editor.splits.filter((s) => s.key !== split.key),
                        })
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p data-testid="imbalance">
            {draftCents.invalid
              ? "Imbalance: enter every amount as a dollar amount such as 12.34."
              : `Imbalance: ${formatReportDollars(draftCents.total)}`}
          </p>
          <button
            type="button"
            onClick={() => setEditor({ ...editor, splits: [...editor.splits, blankSplit()] })}
          >
            Add split
          </button>{" "}
          <button type="submit" disabled={!canSave}>
            Save transaction
          </button>{" "}
          <button type="button" onClick={closeEditor}>
            Cancel
          </button>
        </form>
      )}

      {!accountsLoaded ? (
        <p className="muted">Loading register…</p>
      ) : selectedAccount === null ? (
        <p className="muted">No accounts to show a register for.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Payee</th>
              <th scope="col">Memo</th>
              <th scope="col">Account</th>
              <th scope="col">Increase</th>
              <th scope="col">Decrease</th>
              <th scope="col">Balance</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const natural = naturalBalance(selectedType ?? "ASSET", row.amount_cents);
              const balance = naturalBalance(selectedType ?? "ASSET", row.running_balance_cents);
              const confirming = deleteConfirmId === row.transaction_id;
              const payee = row.payee_id === null ? undefined : payeesById.get(row.payee_id);
              return (
                <tr key={row.transaction_id} data-transaction-id={row.transaction_id}>
                  <td>{row.date}</td>
                  <td>{payee?.name ?? ""}</td>
                  <td>{row.memo ?? ""}</td>
                  <td>{row.counterpart}</td>
                  <td data-testid={`increase-${row.transaction_id}`}>
                    {natural > 0 ? formatReportDollars(natural) : ""}
                  </td>
                  <td data-testid={`decrease-${row.transaction_id}`}>
                    {natural < 0 ? formatReportDollars(-natural) : ""}
                  </td>
                  <td data-testid={`balance-${row.transaction_id}`}>
                    {formatReportDollars(balance)}
                  </td>
                  <td>
                    {confirming ? (
                      <span role="group" aria-label={`Confirm delete ${row.date}`}>
                        Delete this transaction?{" "}
                        <button
                          type="button"
                          onClick={() => void handleConfirmDelete(row.transaction_id)}
                        >
                          Confirm delete
                        </button>{" "}
                        <button type="button" onClick={() => setDeleteConfirmId(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={`Edit transaction ${row.transaction_id}`}
                          onClick={() => openEditEditor(row)}
                        >
                          Edit
                        </button>{" "}
                        <button
                          type="button"
                          aria-label={`Delete transaction ${row.transaction_id}`}
                          onClick={() => {
                            clearMessages();
                            setDeleteConfirmId(row.transaction_id);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <form onSubmit={handleTransfer} aria-label="Transfer form">
        <h2>Transfer</h2>
        <label>
          Transfer from{" "}
          <select value={transferFrom} onChange={(e) => setTransferFrom(e.target.value)}>
            <option value="">Select an account…</option>
            {activePostable.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Transfer to{" "}
          <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
            <option value="">Select an account…</option>
            {activePostable.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Transfer amount{" "}
          <input
            type="text"
            inputMode="decimal"
            value={transferAmount}
            onChange={(e) => setTransferAmount(e.target.value)}
          />
        </label>{" "}
        <label>
          Transfer date{" "}
          <input
            type="date"
            value={transferDate}
            onChange={(e) => setTransferDate(e.target.value)}
          />
        </label>{" "}
        <label>
          Transfer memo{" "}
          <input
            type="text"
            value={transferMemo}
            onChange={(e) => setTransferMemo(e.target.value)}
          />
        </label>{" "}
        <button type="submit">Record transfer</button>
      </form>

      <form onSubmit={handleIncome} aria-label="Income form">
        <h2>Income</h2>
        <label>
          Income account{" "}
          <select value={incomeAccount} onChange={(e) => setIncomeAccount(e.target.value)}>
            <option value="">Select an account…</option>
            {incomeChoices.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Deposit account{" "}
          <select value={incomeDeposit} onChange={(e) => setIncomeDeposit(e.target.value)}>
            <option value="">Select an account…</option>
            {depositChoices.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Income amount{" "}
          <input
            type="text"
            inputMode="decimal"
            value={incomeAmount}
            onChange={(e) => setIncomeAmount(e.target.value)}
          />
        </label>{" "}
        <label>
          Income date{" "}
          <input type="date" value={incomeDate} onChange={(e) => setIncomeDate(e.target.value)} />
        </label>{" "}
        <label>
          Income payee{" "}
          <select value={incomePayee} onChange={(e) => setIncomePayee(e.target.value)}>
            <option value="">None</option>
            {payees
              .filter((p) => !p.archived)
              .map((payee) => (
                <option key={payee.id} value={payee.id}>
                  {payee.name}
                </option>
              ))}
          </select>
        </label>{" "}
        <label>
          Income memo{" "}
          <input type="text" value={incomeMemo} onChange={(e) => setIncomeMemo(e.target.value)} />
        </label>{" "}
        {accountsLoaded && incomeChoices.length === 0 ? (
          <p data-testid="income-empty-hint">
            No income accounts yet — add one under Income on the Accounts page.
          </p>
        ) : null}
        <button type="submit" disabled={accountsLoaded && incomeChoices.length === 0}>
          Record income
        </button>
      </form>
    </section>
  );
}
