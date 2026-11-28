/**
 * Accounts page: the double-entry account tree with natural-sign balances as of
 * a date, plus add/edit/archive, opening balances, and register navigation.
 * Data access goes through `repos` and the core public entry only.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DatabaseLockedError,
  EntityInUseError,
  ForeignKeyViolationError,
  ValidationError,
  formatLocalIsoDate,
  getAccountTree,
  naturalBalance,
  setOpeningBalance,
  type AccountSubtype,
  type AccountTreeNode,
  type AccountType,
  type LedgerAccount,
  type Repositories,
} from "../core";
import { formatReportDollars } from "./report-charts";

export interface AccountsPageProps {
  repos: Repositories;
  /** Called with the account id when the user opens an account's register. */
  onOpenRegister: (accountId: number) => void;
}

type FormMode = { kind: "add" } | { kind: "edit"; accountId: number } | null;

interface AccountFormState {
  name: string;
  parentId: string;
  subtype: string;
  last4: string;
}

const EMPTY_FORM: AccountFormState = { name: "", parentId: "", subtype: "", last4: "" };

const SUBTYPES_BY_TYPE: Partial<Record<AccountType, readonly AccountSubtype[]>> = {
  ASSET: ["bank", "cash", "savings"],
  LIABILITY: ["credit_card", "loan"],
};

function toUiErrorMessage(error: unknown): string {
  if (error instanceof DatabaseLockedError) {
    return "Database is locked by another program — most likely an external SQLite tool has this book file open. Close it, then try again.";
  }
  if (
    error instanceof ValidationError ||
    error instanceof ForeignKeyViolationError ||
    error instanceof EntityInUseError
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Same rules as `parseCurrencyToCents` in PaymentsPage.tsx (duplicated: that one is module-private). */
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

function isRoot(account: LedgerAccount): boolean {
  return account.parent_id === null;
}

function isProtected(account: LedgerAccount): boolean {
  return isRoot(account) || account.system_role !== null;
}

function describeSubtype(subtype: AccountSubtype | null): string {
  return subtype === null ? "" : subtype.replace("_", " ");
}

interface FlatRow {
  node: AccountTreeNode;
  depth: number;
}

function flatten(nodes: AccountTreeNode[], depth = 0): FlatRow[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);
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

/** The account and every descendant id (used to keep cycles out of the parent picker). */
function descendantIds(accounts: LedgerAccount[], rootId: number): Set<number> {
  const ids = new Set<number>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const account of accounts) {
      if (account.parent_id !== null && ids.has(account.parent_id) && !ids.has(account.id)) {
        ids.add(account.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function AccountsPage({ repos, onOpenRegister }: AccountsPageProps) {
  const [asOf, setAsOf] = useState(() => formatLocalIsoDate(new Date()));
  const [showArchived, setShowArchived] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [tree, setTree] = useState<AccountTreeNode[]>([]);
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [formMode, setFormMode] = useState<FormMode>(null);
  const [form, setForm] = useState<AccountFormState>(EMPTY_FORM);
  const [archiveConfirmId, setArchiveConfirmId] = useState<number | null>(null);

  const [openingAccountId, setOpeningAccountId] = useState("");
  const [openingDate, setOpeningDate] = useState(() => formatLocalIsoDate(new Date()));
  const [openingAmount, setOpeningAmount] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nextTree, nextAccounts] = await Promise.all([
          getAccountTree(repos.ledger, { asOf, includeArchived: showArchived }),
          repos.ledger.listAccounts(),
        ]);
        if (cancelled) return;
        setTree(nextTree);
        setAccounts(nextAccounts);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(toUiErrorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repos, asOf, showArchived, refresh]);

  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const rows = useMemo(() => flatten(tree), [tree]);

  const editingAccount =
    formMode?.kind === "edit" ? (accountsById.get(formMode.accountId) ?? null) : null;

  /** Valid parents: non-placeholder accounts, or a root; never archived. */
  const parentOptions = useMemo(() => {
    const excluded =
      editingAccount === null ? new Set<number>() : descendantIds(accounts, editingAccount.id);
    return accounts.filter(
      (account) =>
        !excluded.has(account.id) &&
        (editingAccount === null || account.type === editingAccount.type) &&
        // The current parent always stays selectable so the picker never hides it.
        ((!account.archived && (!account.placeholder || isRoot(account))) ||
          account.id === editingAccount?.parent_id),
    );
  }, [accounts, editingAccount]);

  const selectedParent = accountsById.get(Number(form.parentId)) ?? null;
  const formType: AccountType | null =
    editingAccount !== null ? editingAccount.type : (selectedParent?.type ?? null);
  const subtypeChoices = formType === null ? undefined : SUBTYPES_BY_TYPE[formType];

  const openingChoices = useMemo(
    () =>
      accounts.filter(
        (account) =>
          !account.archived &&
          !account.placeholder &&
          account.system_role === null &&
          account.type !== "EQUITY",
      ),
    [accounts],
  );

  function openAddForm() {
    setError(null);
    setStatus(null);
    setForm(EMPTY_FORM);
    setFormMode({ kind: "add" });
  }

  function openEditForm(account: LedgerAccount) {
    setError(null);
    setStatus(null);
    setForm({
      name: account.name,
      parentId: account.parent_id === null ? "" : String(account.parent_id),
      subtype: account.subtype ?? "",
      last4: account.last4 ?? "",
    });
    setFormMode({ kind: "edit", accountId: account.id });
  }

  function closeForm() {
    setFormMode(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmitAccount(event: FormEvent) {
    event.preventDefault();
    if (formMode === null) return;
    setError(null);
    setStatus(null);

    const name = form.name.trim();
    if (name.length === 0) {
      setError("Account name is required.");
      return;
    }
    const last4 = form.last4.trim();
    if (last4.length > 0 && !/^\d{4}$/.test(last4)) {
      setError("Last 4 must be exactly four digits.");
      return;
    }
    if (formType === null || form.parentId === "") {
      setError("Choose a parent account.");
      return;
    }
    const subtype = (
      subtypeChoices !== undefined && form.subtype !== "" ? form.subtype : null
    ) as AccountSubtype | null;

    try {
      if (formMode.kind === "add") {
        await repos.ledger.insertAccount({
          name,
          type: formType,
          subtype,
          parent_id: Number(form.parentId),
          last4: last4.length > 0 ? last4 : null,
        });
        setStatus(`Added account "${name}".`);
      } else {
        await repos.ledger.updateAccount(formMode.accountId, {
          name,
          parent_id: Number(form.parentId),
          ...(subtypeChoices !== undefined ? { subtype } : {}),
          last4: last4.length > 0 ? last4 : null,
        });
        setStatus(`Updated account "${name}".`);
      }
      closeForm();
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  async function handleConfirmArchive(account: LedgerAccount) {
    setError(null);
    setStatus(null);
    try {
      await repos.ledger.archiveAccount(account.id);
      setArchiveConfirmId(null);
      setStatus(`Archived account "${account.name}".`);
      setRefresh((n) => n + 1);
    } catch (e) {
      setArchiveConfirmId(null);
      setError(toUiErrorMessage(e));
    }
  }

  async function handleSetOpeningBalance(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setStatus(null);

    if (openingAccountId === "") {
      setError("Choose an account for the opening balance.");
      return;
    }
    const cents = parseCurrencyToCents(openingAmount);
    if (cents === null) {
      setError("Enter the opening balance as a dollar amount such as 1234.56.");
      return;
    }
    try {
      await setOpeningBalance(repos.ledger, Number(openingAccountId), openingDate, cents);
      setStatus(
        cents === 0
          ? "Opening balance cleared."
          : `Opening balance set to ${formatReportDollars(cents)}.`,
      );
      setOpeningAmount("");
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  return (
    <section className="page">
      <h1>Accounts</h1>
      <p className="muted">Your account tree and balances.</p>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status !== null && <p role="status">{status}</p>}

      <div className="toolbar">
        <label>
          As of <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>{" "}
        <label>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />{" "}
          Show archived
        </label>{" "}
        <button type="button" onClick={openAddForm}>
          Add account
        </button>
      </div>

      {formMode !== null && (
        <form onSubmit={handleSubmitAccount} aria-label="Account form">
          <h2>{formMode.kind === "add" ? "Add account" : "Edit account"}</h2>
          <label>
            Name{" "}
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>{" "}
          <label>
            Parent{" "}
            <select
              value={form.parentId}
              onChange={(e) =>
                setForm({
                  ...form,
                  parentId: e.target.value,
                  // Edit mode keeps the type (and so the subtype); add mode may change type.
                  subtype: editingAccount !== null ? form.subtype : "",
                })
              }
            >
              <option value="">Select a parent…</option>
              {parentOptions.map((account) => (
                <option key={account.id} value={account.id}>
                  {accountPath(account, accountsById)}
                  {account.id === editingAccount?.parent_id ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>{" "}
          <span>Type: {formType ?? "—"}</span>{" "}
          {subtypeChoices !== undefined && (
            <label>
              Subtype{" "}
              <select
                value={form.subtype}
                onChange={(e) => setForm({ ...form, subtype: e.target.value })}
              >
                <option value="">None</option>
                {subtypeChoices.map((subtype) => (
                  <option key={subtype} value={subtype}>
                    {describeSubtype(subtype)}
                  </option>
                ))}
              </select>
            </label>
          )}{" "}
          <label>
            Last 4 digits{" "}
            <input
              type="text"
              inputMode="numeric"
              value={form.last4}
              onChange={(e) => setForm({ ...form, last4: e.target.value })}
            />
          </label>{" "}
          <button type="submit">
            {formMode.kind === "add" ? "Create account" : "Save changes"}
          </button>{" "}
          <button type="button" onClick={closeForm}>
            Cancel
          </button>
        </form>
      )}

      <form onSubmit={handleSetOpeningBalance} aria-label="Opening balance form">
        <h2>Set opening balance</h2>
        <label>
          Opening balance account{" "}
          <select value={openingAccountId} onChange={(e) => setOpeningAccountId(e.target.value)}>
            <option value="">Select an account…</option>
            {openingChoices.map((account) => (
              <option key={account.id} value={account.id}>
                {accountPath(account, accountsById)}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Opening balance date{" "}
          <input type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />
        </label>{" "}
        <label>
          Opening balance amount{" "}
          <input
            type="text"
            inputMode="decimal"
            value={openingAmount}
            onChange={(e) => setOpeningAmount(e.target.value)}
          />
        </label>{" "}
        <button type="submit">Set opening balance</button>
      </form>

      {loading && tree.length === 0 ? (
        <p className="muted">Loading accounts…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Type</th>
              <th scope="col">Subtype</th>
              <th scope="col">Last 4</th>
              <th scope="col">Balance</th>
              <th scope="col">Rolled-up balance</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth }) => {
              const { account } = node;
              const confirming = archiveConfirmId === account.id;
              return (
                <tr key={account.id} data-account-id={account.id}>
                  <td style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onOpenRegister(account.id)}
                    >
                      {account.name}
                    </button>
                    {account.archived ? <span className="muted"> (archived)</span> : null}
                  </td>
                  <td>{account.type}</td>
                  <td>{describeSubtype(account.subtype)}</td>
                  <td>{account.last4 ?? ""}</td>
                  <td data-testid={`own-${account.id}`}>
                    {formatReportDollars(naturalBalance(account.type, node.own_balance_cents))}
                  </td>
                  <td data-testid={`rolled-${account.id}`}>
                    {formatReportDollars(
                      naturalBalance(account.type, node.rolled_up_balance_cents),
                    )}
                  </td>
                  <td>
                    {isProtected(account) ? null : confirming ? (
                      <span role="group" aria-label={`Confirm archive ${account.name}`}>
                        Archive {account.name}?{" "}
                        <button type="button" onClick={() => void handleConfirmArchive(account)}>
                          Confirm archive
                        </button>{" "}
                        <button type="button" onClick={() => setArchiveConfirmId(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={`Edit ${account.name}`}
                          onClick={() => openEditForm(account)}
                        >
                          Edit
                        </button>{" "}
                        {!account.archived && (
                          <button
                            type="button"
                            aria-label={`Archive ${account.name}`}
                            onClick={() => setArchiveConfirmId(account.id)}
                          >
                            Archive
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
