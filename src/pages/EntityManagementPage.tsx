import { useEffect, useMemo, useState } from "react";
import {
  DatabaseLockedError,
  EntityInUseError,
  ForeignKeyViolationError,
  PayeeMergeError,
  ValidationError,
  type Account,
  type AccountKind,
  type Category,
  type Payee,
  type Repositories,
} from "../core";

interface EntityManagementPageProps {
  repos: Repositories;
}

type LoadState = "idle" | "loading";

interface PayeeFormState {
  editingId: number | null;
  name: string;
  defaultAccountId: string;
  defaultCategoryId: string;
  notes: string;
}

interface AccountFormState {
  editingId: number | null;
  name: string;
  kind: AccountKind;
  last4: string;
}

interface CategoryFormState {
  editingId: number | null;
  name: string;
  parentId: string;
}

function toUiErrorMessage(error: unknown): string {
  if (error instanceof ValidationError) return error.message;
  if (error instanceof EntityInUseError) return error.message;
  if (error instanceof PayeeMergeError) return error.message;
  if (error instanceof ForeignKeyViolationError) {
    return "A selected default reference is invalid. Choose an existing account/category and try again.";
  }
  if (error instanceof DatabaseLockedError) {
    return "Database is locked by another program — most likely an external SQLite tool (for example the sqlite3 CLI or DB Browser) has this book file open. Close it, then try again.";
  }
  return error instanceof Error ? error.message : String(error);
}

function parseOptionalId(raw: string): number | null {
  if (raw === "") return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) ? value : null;
}

const EMPTY_PAYEE_FORM: PayeeFormState = {
  editingId: null,
  name: "",
  defaultAccountId: "",
  defaultCategoryId: "",
  notes: "",
};

const EMPTY_ACCOUNT_FORM: AccountFormState = {
  editingId: null,
  name: "",
  kind: "checking",
  last4: "",
};

const EMPTY_CATEGORY_FORM: CategoryFormState = {
  editingId: null,
  name: "",
  parentId: "",
};

export function EntityManagementPage({ repos }: EntityManagementPageProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [payees, setPayees] = useState<Payee[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  const [payeeForm, setPayeeForm] = useState<PayeeFormState>(EMPTY_PAYEE_FORM);
  const [accountForm, setAccountForm] = useState<AccountFormState>(EMPTY_ACCOUNT_FORM);
  const [categoryForm, setCategoryForm] = useState<CategoryFormState>(EMPTY_CATEGORY_FORM);

  const [mergeSurvivorId, setMergeSurvivorId] = useState<string>("");
  const [mergeSourceId, setMergeSourceId] = useState<string>("");

  const activeAccounts = useMemo(() => accounts.filter((account) => !account.archived), [accounts]);
  const activeCategories = useMemo(
    () => categories.filter((category) => !category.archived),
    [categories],
  );
  const activePayees = useMemo(() => payees.filter((payee) => !payee.archived), [payees]);

  async function reloadEntities() {
    setLoadState("loading");
    setError(null);
    try {
      const [nextPayees, nextAccounts, nextCategories] = await Promise.all([
        repos.payees.list({ includeArchived: true }),
        repos.accounts.list({ includeArchived: true }),
        repos.categories.list({ includeArchived: true }),
      ]);
      setPayees(nextPayees);
      setAccounts(nextAccounts);
      setCategories(nextCategories);
    } catch (e) {
      setError(toUiErrorMessage(e));
    } finally {
      setLoadState("idle");
    }
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [nextPayees, nextAccounts, nextCategories] = await Promise.all([
          repos.payees.list({ includeArchived: true }),
          repos.accounts.list({ includeArchived: true }),
          repos.categories.list({ includeArchived: true }),
        ]);
        if (cancelled) return;

        setPayees(nextPayees);
        setAccounts(nextAccounts);
        setCategories(nextCategories);
      } catch (e) {
        if (!cancelled) setError(toUiErrorMessage(e));
      } finally {
        if (!cancelled) setLoadState("idle");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repos]);

  async function run(action: () => Promise<void>) {
    setError(null);
    setStatus(null);
    try {
      await action();
      await reloadEntities();
    } catch (e) {
      setError(toUiErrorMessage(e));
    }
  }

  async function submitPayeeForm() {
    await run(async () => {
      if (payeeForm.editingId === null) {
        await repos.payees.insert({
          name: payeeForm.name,
          default_account_id: parseOptionalId(payeeForm.defaultAccountId),
          default_category_id: parseOptionalId(payeeForm.defaultCategoryId),
          notes: payeeForm.notes.trim() === "" ? null : payeeForm.notes,
        });
        setStatus("Payee created.");
      } else {
        await repos.payees.update(payeeForm.editingId, {
          name: payeeForm.name,
          default_account_id: parseOptionalId(payeeForm.defaultAccountId),
          default_category_id: parseOptionalId(payeeForm.defaultCategoryId),
          notes: payeeForm.notes.trim() === "" ? null : payeeForm.notes,
        });
        setStatus("Payee updated.");
      }
      setPayeeForm(EMPTY_PAYEE_FORM);
    });
  }

  async function submitAccountForm() {
    await run(async () => {
      const last4 = accountForm.last4.trim();
      if (accountForm.editingId === null) {
        await repos.accounts.insert({
          name: accountForm.name,
          kind: accountForm.kind,
          last4: last4 === "" ? null : last4,
        });
        setStatus("Account created.");
      } else {
        await repos.accounts.update(accountForm.editingId, {
          name: accountForm.name,
          kind: accountForm.kind,
          last4: last4 === "" ? null : last4,
        });
        setStatus("Account updated.");
      }
      setAccountForm(EMPTY_ACCOUNT_FORM);
    });
  }

  async function submitCategoryForm() {
    await run(async () => {
      if (categoryForm.editingId === null) {
        await repos.categories.insert({
          name: categoryForm.name,
          parent_id: parseOptionalId(categoryForm.parentId),
        });
        setStatus("Category created.");
      } else {
        await repos.categories.update(categoryForm.editingId, {
          name: categoryForm.name,
          parent_id: parseOptionalId(categoryForm.parentId),
        });
        setStatus("Category updated.");
      }
      setCategoryForm(EMPTY_CATEGORY_FORM);
    });
  }

  async function runPayeeMerge() {
    const survivorId = parseOptionalId(mergeSurvivorId);
    const sourceId = parseOptionalId(mergeSourceId);
    if (survivorId === null || sourceId === null) return;

    await run(async () => {
      const result = await repos.payees.merge(survivorId, sourceId);
      setStatus(
        `Payees merged. Reassigned ${result.reassignedPayments} payment${
          result.reassignedPayments === 1 ? "" : "s"
        } and archived the source payee.`,
      );
      setMergeSourceId("");
    });
  }

  function startPayeeEdit(payee: Payee) {
    setPayeeForm({
      editingId: payee.id,
      name: payee.name,
      defaultAccountId: payee.default_account_id === null ? "" : String(payee.default_account_id),
      defaultCategoryId:
        payee.default_category_id === null ? "" : String(payee.default_category_id),
      notes: payee.notes ?? "",
    });
  }

  function startAccountEdit(account: Account) {
    setAccountForm({
      editingId: account.id,
      name: account.name,
      kind: account.kind,
      last4: account.last4 ?? "",
    });
  }

  function startCategoryEdit(category: Category) {
    setCategoryForm({
      editingId: category.id,
      name: category.name,
      parentId: category.parent_id === null ? "" : String(category.parent_id),
    });
  }

  return (
    <section className="page entity-management-page">
      <h1>Manage Entities</h1>
      <p className="muted">
        Create, edit, archive, delete, and merge your payees/accounts/categories.
      </p>

      {status && <p className="status">{status}</p>}
      {error && <p className="error">{error}</p>}
      {loadState === "loading" && <p className="muted">Refreshing entities…</p>}

      <section className="entity-section">
        <h2>Payees</h2>
        <form
          className="entity-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitPayeeForm();
          }}
        >
          <label className="field">
            Name
            <input
              value={payeeForm.name}
              onChange={(event) => setPayeeForm((current) => ({ ...current, name: event.currentTarget.value }))}
            />
          </label>
          <label className="field">
            Default account
            <select
              value={payeeForm.defaultAccountId}
              onChange={(event) =>
                setPayeeForm((current) => ({ ...current, defaultAccountId: event.currentTarget.value }))
              }
            >
              <option value="">(none)</option>
              {activeAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Default category
            <select
              value={payeeForm.defaultCategoryId}
              onChange={(event) =>
                setPayeeForm((current) => ({ ...current, defaultCategoryId: event.currentTarget.value }))
              }
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
            Notes
            <input
              value={payeeForm.notes}
              onChange={(event) => setPayeeForm((current) => ({ ...current, notes: event.currentTarget.value }))}
            />
          </label>
          <div className="entity-form-actions">
            <button type="submit" className="primary">
              {payeeForm.editingId === null ? "Create payee" : "Save payee"}
            </button>
            {payeeForm.editingId !== null && (
              <button type="button" onClick={() => setPayeeForm(EMPTY_PAYEE_FORM)}>
                Cancel edit
              </button>
            )}
          </div>
        </form>

        <table className="entity-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {payees.map((payee) => (
              <tr key={payee.id}>
                <td>{payee.name}</td>
                <td>{payee.archived ? "Archived" : "Active"}</td>
                <td className="entity-actions-cell">
                  <button type="button" onClick={() => startPayeeEdit(payee)}>
                    Edit
                  </button>
                  {!payee.archived && (
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          const archived = await repos.payees.archive(payee.id);
                          if (!archived) throw new Error("Payee not found.");
                          setStatus("Payee archived.");
                        })
                      }
                    >
                      Archive
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        const deleted = await repos.payees.delete(payee.id);
                        if (!deleted) throw new Error("Payee not found.");
                        setStatus("Payee deleted.");
                      })
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Merge payees</h3>
        <div className="entity-inline-controls">
          <label className="field">
            Survivor
            <select value={mergeSurvivorId} onChange={(event) => setMergeSurvivorId(event.currentTarget.value)}>
              <option value="">Select payee</option>
              {activePayees.map((payee) => (
                <option key={payee.id} value={payee.id}>
                  {payee.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Source to merge
            <select value={mergeSourceId} onChange={(event) => setMergeSourceId(event.currentTarget.value)}>
              <option value="">Select payee</option>
              {activePayees.map((payee) => (
                <option key={payee.id} value={payee.id}>
                  {payee.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary"
            disabled={mergeSurvivorId === "" || mergeSourceId === "" || mergeSurvivorId === mergeSourceId}
            onClick={() => void runPayeeMerge()}
          >
            Merge payees
          </button>
        </div>
      </section>

      <section className="entity-section">
        <h2>Accounts</h2>
        <form
          className="entity-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAccountForm();
          }}
        >
          <label className="field">
            Name
            <input
              value={accountForm.name}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setAccountForm((current) => ({ ...current, name: value }));
              }}
            />
          </label>
          <label className="field">
            Kind
            <select
              value={accountForm.kind}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setAccountForm((current) => ({ ...current, kind: value as AccountKind }));
              }}
            >
              <option value="checking">Checking</option>
              <option value="credit">Credit</option>
              <option value="cash">Cash</option>
            </select>
          </label>
          <label className="field">
            Last 4 (optional)
            <input
              value={accountForm.last4}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setAccountForm((current) => ({ ...current, last4: value }));
              }}
            />
          </label>
          <div className="entity-form-actions">
            <button type="submit" className="primary">
              {accountForm.editingId === null ? "Create account" : "Save account"}
            </button>
            {accountForm.editingId !== null && (
              <button type="button" onClick={() => setAccountForm(EMPTY_ACCOUNT_FORM)}>
                Cancel edit
              </button>
            )}
          </div>
        </form>

        <table className="entity-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>{account.name}</td>
                <td>{account.kind}</td>
                <td>{account.archived ? "Archived" : "Active"}</td>
                <td className="entity-actions-cell">
                  <button type="button" onClick={() => startAccountEdit(account)}>
                    Edit
                  </button>
                  {!account.archived && (
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          const archived = await repos.accounts.archive(account.id);
                          if (!archived) throw new Error("Account not found.");
                          setStatus("Account archived.");
                        })
                      }
                    >
                      Archive
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        const deleted = await repos.accounts.delete(account.id);
                        if (!deleted) throw new Error("Account not found.");
                        setStatus("Account deleted.");
                      })
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="entity-section">
        <h2>Categories</h2>
        <form
          className="entity-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCategoryForm();
          }}
        >
          <label className="field">
            Name
            <input
              value={categoryForm.name}
              onChange={(event) =>
                setCategoryForm((current) => ({ ...current, name: event.currentTarget.value }))
              }
            />
          </label>
          <label className="field">
            Parent category
            <select
              value={categoryForm.parentId}
              onChange={(event) =>
                setCategoryForm((current) => ({ ...current, parentId: event.currentTarget.value }))
              }
            >
              <option value="">(none)</option>
              {activeCategories
                .filter((category) => category.id !== categoryForm.editingId)
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="entity-form-actions">
            <button type="submit" className="primary">
              {categoryForm.editingId === null ? "Create category" : "Save category"}
            </button>
            {categoryForm.editingId !== null && (
              <button type="button" onClick={() => setCategoryForm(EMPTY_CATEGORY_FORM)}>
                Cancel edit
              </button>
            )}
          </div>
        </form>

        <table className="entity-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Parent</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => {
              const parent = categories.find((item) => item.id === category.parent_id) ?? null;
              return (
                <tr key={category.id}>
                  <td>{category.name}</td>
                  <td>{parent?.name ?? "-"}</td>
                  <td>{category.archived ? "Archived" : "Active"}</td>
                  <td className="entity-actions-cell">
                    <button type="button" onClick={() => startCategoryEdit(category)}>
                      Edit
                    </button>
                    {!category.archived && (
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () => {
                            const archived = await repos.categories.archive(category.id);
                            if (!archived) throw new Error("Category not found.");
                            setStatus("Category archived.");
                          })
                        }
                      >
                        Archive
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          const deleted = await repos.categories.delete(category.id);
                          if (!deleted) throw new Error("Category not found.");
                          setStatus("Category deleted.");
                        })
                      }
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </section>
  );
}
