import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  DatabaseLockedError,
  GnucashMappingConflictError,
  SUPPORTED_GNUCASH_RESAVE,
  applyAccountMapping,
  applyCategoryMapping,
  buildCsv,
  buildQif,
  clearMapping,
  commitGnucashImport,
  formatCentsDecimal,
  listExportablePayments,
  mappingStatus,
  planGnucashImport,
  reconcile,
  recordExport,
  setManualMatch,
  setManualUnmatch,
  suggestAccountMappings,
  suggestCategoryMappings,
  summarize,
  validateForExport,
  type Account,
  type Category,
  type Database,
  type ExportablePayment,
  type GnucashAccount,
  type GnucashAccountType,
  type GnucashBookProbe,
  type GnucashImportFieldDiff,
  type GnucashImportPlan,
  type GnucashTransactionList,
  type Payee,
  type Repositories,
} from "../core";
import {
  gnucashListAccounts,
  gnucashListTransactions,
  gnucashProbeBook,
  loadGnucashBookState,
  updateGnucashBookState,
  type GnucashBookState,
} from "../gnucash-book";
import { exportReportCsv, type ExportReportCsvError } from "../report-csv";

export interface GnuCashPageProps {
  db: Database;
  repos: Repositories;
  pickBookPath?: () => Promise<string | null>;
  pickSavePath?: (defaultPath: string) => Promise<string | null>;
}

type GnuCashTab = "link" | "mapping" | "import" | "export" | "reconcile";
type ImportStep = "setup" | "review" | "done";

const TABS: { id: GnuCashTab; label: string }[] = [
  { id: "link", label: "Link book" },
  { id: "mapping", label: "Account mapping" },
  { id: "import", label: "Import" },
  { id: "export", label: "Export" },
  { id: "reconcile", label: "Reconcile" },
];

const ACCOUNT_ELIGIBLE_TYPES = new Set<GnucashAccountType>([
  "BANK",
  "CASH",
  "CREDIT",
  "LIABILITY",
]);

function toUiErrorMessage(error: unknown): string {
  if (error instanceof DatabaseLockedError) {
    return "Database is locked by another program — most likely an external SQLite tool (for example the sqlite3 CLI or DB Browser) has this book file open. Close it, then try again.";
  }
  if (error instanceof GnucashMappingConflictError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function toCurrency(amountCents: number): string {
  const formatted = formatCentsDecimal(amountCents);
  if (formatted.startsWith("-")) {
    return `-$${formatted.slice(1)}`;
  }
  return `$${formatted}`;
}

function defaultYearDateWindow(): { from: string; to: string } {
  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  return { from: `${year}-01-01`, to: today };
}

function probeBlockingMessage(probe: GnucashBookProbe): string {
  switch (probe.status) {
    case "missing":
      return "The linked GnuCash book file could not be found. It may have been moved or deleted.";
    case "xml":
      return "The linked file is a GnuCash XML book. Convert it to sqlite3 format on the Link book tab before using mapping, import, export, or reconcile.";
    case "unknown-schema":
      return `The linked GnuCash book uses an unsupported schema (${probe.detail}). Re-save the book in GnuCash with GnuCash-Resave ${SUPPORTED_GNUCASH_RESAVE}.`;
    case "unreadable":
      return probe.detail.length > 0
        ? `The linked GnuCash book could not be read: ${probe.detail}`
        : "The linked GnuCash book could not be read.";
    default:
      return "The linked GnuCash book is not usable.";
  }
}

function exportWriteErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const typed = error as ExportReportCsvError;
    if (typed.kind === "write_failed") {
      return `Could not write file to ${typed.path}: ${typed.message}`;
    }
  }
  return toUiErrorMessage(error);
}

function formatDiffValue(field: string, value: string | number | null): string {
  if (value === null) return "—";
  if (field === "amount_cents" && typeof value === "number") {
    return toCurrency(value);
  }
  return String(value);
}

interface AccountTreeNode {
  account: GnucashAccount;
  children: AccountTreeNode[];
}

function buildAccountTree(accounts: GnucashAccount[]): AccountTreeNode[] {
  const childrenByParent = new Map<string | null, GnucashAccount[]>();
  for (const account of accounts) {
    const parent = account.parent_guid;
    const siblings = childrenByParent.get(parent) ?? [];
    siblings.push(account);
    childrenByParent.set(parent, siblings);
  }

  function build(parentGuid: string | null): AccountTreeNode[] {
    const siblings = (childrenByParent.get(parentGuid) ?? []).sort((a, b) =>
      a.full_path.localeCompare(b.full_path),
    );
    return siblings.map((account) => ({
      account,
      children: build(account.guid),
    }));
  }

  return build(null);
}

function eligibleImportAccounts(accounts: GnucashAccount[]): GnucashAccount[] {
  return accounts.filter(
    (account) => !account.placeholder && ACCOUNT_ELIGIBLE_TYPES.has(account.account_type),
  );
}

function eligibleMappingAccounts(accounts: GnucashAccount[]): GnucashAccount[] {
  return eligibleImportAccounts(accounts);
}

function eligibleMappingCategories(accounts: GnucashAccount[]): GnucashAccount[] {
  return accounts
    .filter((account) => !account.placeholder && account.account_type === "EXPENSE")
    .sort((a, b) => a.full_path.localeCompare(b.full_path));
}

function isTabBlocked(
  tab: GnuCashTab,
  bookPath: string | null,
  probe: GnucashBookProbe | null,
  probing: boolean,
): boolean {
  if (tab === "link") return false;
  if (bookPath === null) return true;
  if (probing || probe === null) return true;
  return probe.status !== "ok";
}

function tabBlockingReason(
  bookPath: string | null,
  probe: GnucashBookProbe | null,
  probing: boolean,
): string {
  if (bookPath === null) {
    return "Link a GnuCash sqlite3 book before using mapping, import, export, or reconcile.";
  }
  if (probing || probe === null) {
    return "Checking linked GnuCash book…";
  }
  if (probe.status !== "ok") {
    return probeBlockingMessage(probe);
  }
  return "";
}

export function GnuCashPage({
  db,
  repos,
  pickBookPath,
  pickSavePath,
}: GnuCashPageProps) {
  const [tab, setTab] = useState<GnuCashTab>("link");
  const [bookState, setBookState] = useState<GnucashBookState | null>(null);
  const [probe, setProbe] = useState<GnucashBookProbe | null>(null);
  const [accountCount, setAccountCount] = useState<number | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const [finAccounts, setFinAccounts] = useState<Account[]>([]);
  const [finCategories, setFinCategories] = useState<Category[]>([]);
  const [gnucashAccounts, setGnucashAccounts] = useState<GnucashAccount[]>([]);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [mappingActionError, setMappingActionError] = useState<string | null>(null);
  const [mappingBusy, setMappingBusy] = useState(false);

  const [importAccountGuids, setImportAccountGuids] = useState<string[]>([]);
  const [importFrom, setImportFrom] = useState(() => defaultYearDateWindow().from);
  const [importTo, setImportTo] = useState(() => defaultYearDateWindow().to);
  const [importStep, setImportStep] = useState<ImportStep>("setup");
  const [importLoading, setImportLoading] = useState(false);
  const [importCommitting, setImportCommitting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importPlan, setImportPlan] = useState<GnucashImportPlan | null>(null);
  const [importList, setImportList] = useState<GnucashTransactionList | null>(null);
  const [approvedNew, setApprovedNew] = useState<Set<string>>(() => new Set());
  const [approvedUpdates, setApprovedUpdates] = useState<Set<string>>(() => new Set());
  const [approvedMerges, setApprovedMerges] = useState<Set<string>>(() => new Set());
  const [confirmedPayeeIds, setConfirmedPayeeIds] = useState<Record<string, number>>({});
  const [payees, setPayees] = useState<Payee[]>([]);

  const [exportFrom, setExportFrom] = useState(() => defaultYearDateWindow().from);
  const [exportTo, setExportTo] = useState(() => defaultYearDateWindow().to);
  const [includeExported, setIncludeExported] = useState(false);
  const [exportFormat, setExportFormat] = useState<"qif" | "csv">("qif");
  const [exportPayments, setExportPayments] = useState<ExportablePayment[]>([]);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const [reconcileAccountId, setReconcileAccountId] = useState<string>("");
  const [reconcileFrom, setReconcileFrom] = useState(() => defaultYearDateWindow().from);
  const [reconcileTo, setReconcileTo] = useState(() => defaultYearDateWindow().to);
  const [toleranceDays, setToleranceDays] = useState(3);
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconcileResult, setReconcileResult] = useState<Awaited<ReturnType<typeof reconcile>> | null>(
    null,
  );
  const [manualMatchPaymentId, setManualMatchPaymentId] = useState<string>("");
  const [manualMatchTxnGuid, setManualMatchTxnGuid] = useState<string>("");
  const [reconcileBusy, setReconcileBusy] = useState(false);

  const bookPath = bookState?.bookPath ?? null;
  const blocked = isTabBlocked(tab, bookPath, probe, probing);
  const blockingReason = tabBlockingReason(bookPath, probe, probing);

  const refreshProbe = useCallback(async (path: string) => {
    setProbing(true);
    setLinkError(null);
    try {
      const nextProbe = await gnucashProbeBook(path);
      setProbe(nextProbe);
      if (nextProbe.status === "ok") {
        const accounts = await gnucashListAccounts(path);
        setAccountCount(accounts.length);
        setGnucashAccounts(accounts);
      } else {
        setAccountCount(null);
      }
    } catch (error) {
      setProbe(null);
      setAccountCount(null);
      setLinkError(toUiErrorMessage(error));
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLinkLoading(true);
      try {
        const state = await loadGnucashBookState();
        if (cancelled) return;
        setBookState(state);
        setImportAccountGuids(state.importAccountGuids);
        if (state.bookPath !== null) {
          await refreshProbe(state.bookPath);
        }
      } catch (error) {
        if (!cancelled) setLinkError(toUiErrorMessage(error));
      } finally {
        if (!cancelled) setLinkLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshProbe]);

  function handleTabChange(nextTab: GnuCashTab) {
    setTab(nextTab);
    const nextBlocked = isTabBlocked(nextTab, bookPath, probe, probing);
    if (nextTab === "mapping" && !nextBlocked) {
      void loadMappingData();
    }
    if (nextTab === "reconcile" && !nextBlocked) {
      void repos.accounts.list({ includeArchived: true }).then(setFinAccounts);
    }
  }
  const loadMappingData = useCallback(async () => {
    if (bookPath === null || probe?.status !== "ok") return;
    setMappingLoading(true);
    setMappingError(null);
    try {
      const [accounts, categories, gcAccounts, allPayees] = await Promise.all([
        repos.accounts.list({ includeArchived: true }),
        repos.categories.list({ includeArchived: true }),
        gnucashListAccounts(bookPath),
        repos.payees.list({ includeArchived: true }),
      ]);
      setFinAccounts(accounts);
      setFinCategories(categories);
      setGnucashAccounts(gcAccounts);
      setPayees(allPayees);
    } catch (error) {
      setMappingError(toUiErrorMessage(error));
    } finally {
      setMappingLoading(false);
    }
  }, [bookPath, probe?.status, repos]);

  const accountSuggestions = useMemo(
    () => suggestAccountMappings(finAccounts, gnucashAccounts),
    [finAccounts, gnucashAccounts],
  );

  const categorySuggestions = useMemo(
    () => suggestCategoryMappings(finCategories, gnucashAccounts),
    [finCategories, gnucashAccounts],
  );

  const mappingWarnings = useMemo(
    () => mappingStatus(finAccounts, finCategories, gnucashAccounts),
    [finAccounts, finCategories, gnucashAccounts],
  );

  const importTree = useMemo(
    () => buildAccountTree(eligibleImportAccounts(gnucashAccounts)),
    [gnucashAccounts],
  );

  const mappedAccounts = useMemo(
    () => finAccounts.filter((account) => account.gnucash_guid !== null),
    [finAccounts],
  );

  const exportBlockers = useMemo(() => {
    if (exportPayments.length === 0) return [];
    return validateForExport(exportPayments, finAccounts, finCategories).blockers;
  }, [exportPayments, finAccounts, finCategories]);

  async function chooseBook() {
    setLinkError(null);
    setLinkNotice(null);
    setLinkLoading(true);
    try {
      const chosenPath =
        pickBookPath !== undefined
          ? await pickBookPath()
          : ((await open({
              multiple: false,
              directory: false,
              title: "Choose GnuCash book",
              filters: [
                { name: "GnuCash book", extensions: ["gnucash", "sqlite", "db", "sql"] },
              ],
            })) as string | null);

      if (!chosenPath) {
        return;
      }

      const nextProbe = await gnucashProbeBook(chosenPath);
      if (nextProbe.status === "ok") {
        const state = await updateGnucashBookState({ bookPath: chosenPath });
        setBookState(state);
        setProbe(nextProbe);
        const accounts = await gnucashListAccounts(chosenPath);
        setAccountCount(accounts.length);
        setGnucashAccounts(accounts);
        setLinkNotice("GnuCash book linked successfully.");
      } else if (nextProbe.status === "xml") {
        setLinkNotice(
          `This file is a GnuCash XML book. Open it in GnuCash, choose File → Save As, and save as sqlite3 format (supported GnuCash-Resave ${SUPPORTED_GNUCASH_RESAVE}). Then link the saved sqlite3 file here.`,
        );
      } else if (nextProbe.status === "unknown-schema") {
        setLinkError(
          `Unsupported GnuCash schema (${nextProbe.detail}). Re-save the book in GnuCash with GnuCash-Resave ${SUPPORTED_GNUCASH_RESAVE}, then try again.`,
        );
      } else if (nextProbe.status === "unreadable") {
        setLinkError(
          nextProbe.detail.length > 0
            ? `Could not read the selected file: ${nextProbe.detail}`
            : "Could not read the selected file.",
        );
      } else {
        setLinkError("The selected GnuCash book file could not be found.");
      }
    } catch (error) {
      setLinkError(toUiErrorMessage(error));
    } finally {
      setLinkLoading(false);
    }
  }

  function handleRelink() {
    setTab("link");
    void chooseBook();
  }

  async function handleApplyAccountMapping(accountId: number, guid: string) {
    setMappingActionError(null);
    setMappingBusy(true);
    try {
      await applyAccountMapping(repos, accountId, guid);
      await loadMappingData();
    } catch (error) {
      setMappingActionError(toUiErrorMessage(error));
    } finally {
      setMappingBusy(false);
    }
  }

  async function handleApplyCategoryMapping(categoryId: number, guid: string) {
    setMappingActionError(null);
    setMappingBusy(true);
    try {
      await applyCategoryMapping(repos, categoryId, guid);
      await loadMappingData();
    } catch (error) {
      setMappingActionError(toUiErrorMessage(error));
    } finally {
      setMappingBusy(false);
    }
  }

  async function handleClearMapping(kind: "account" | "category", id: number) {
    setMappingActionError(null);
    setMappingBusy(true);
    try {
      await clearMapping(repos, kind, id);
      await loadMappingData();
    } catch (error) {
      setMappingActionError(toUiErrorMessage(error));
    } finally {
      setMappingBusy(false);
    }
  }

  async function persistImportSelection(nextGuids: string[]) {
    setImportAccountGuids(nextGuids);
    try {
      const state = await updateGnucashBookState({ importAccountGuids: nextGuids });
      setBookState(state);
    } catch (error) {
      setImportError(toUiErrorMessage(error));
    }
  }

  function toggleImportAccount(guid: string, checked: boolean) {
    const next = checked
      ? [...importAccountGuids, guid]
      : importAccountGuids.filter((value) => value !== guid);
    void persistImportSelection(next);
  }

  async function planImport() {
    if (bookPath === null) return;
    setImportError(null);
    setImportStatus(null);
    setImportLoading(true);
    try {
      const [list, allPayees] = await Promise.all([
        gnucashListTransactions(bookPath, importAccountGuids, importFrom, importTo),
        repos.payees.list({ includeArchived: true }),
      ]);
      const plan = await planGnucashImport(repos, list, { accountGuids: importAccountGuids });
      setImportList(list);
      setImportPlan(plan);
      setPayees(allPayees);
      setApprovedNew(new Set());
      setApprovedUpdates(new Set());
      setApprovedMerges(new Set());
      setConfirmedPayeeIds({});
      setImportStep("review");
    } catch (error) {
      setImportError(toUiErrorMessage(error));
    } finally {
      setImportLoading(false);
    }
  }

  async function confirmCreatePayee(txnGuid: string, name: string) {
    setImportError(null);
    setImportCommitting(true);
    try {
      const created = await repos.payees.insert({ name });
      setConfirmedPayeeIds((current) => ({ ...current, [txnGuid]: created.id }));
      setPayees((current) => [...current, created]);
    } catch (error) {
      setImportError(toUiErrorMessage(error));
    } finally {
      setImportCommitting(false);
    }
  }

  async function commitImport() {
    if (!importPlan || !importList) return;
    setImportError(null);
    setImportCommitting(true);
    try {
      const result = await commitGnucashImport(db, repos, {
        approvedNewTxnGuids: [...approvedNew],
        approvedUpdateTxnGuids: [...approvedUpdates],
        approvedMergeTxnGuids: [...approvedMerges],
        confirmedPayeeIds,
        list: importList,
        options: { accountGuids: importAccountGuids },
      });

      const unreadableCount = importPlan.unreadable.length;
      const updatedCount = approvedUpdates.size;
      const parts = [
        `${result.inserted} inserted`,
        `${result.merged} merged`,
        `${result.skipped} skipped`,
      ];
      if (updatedCount > 0) {
        parts.push(`${updatedCount} payment(s) updated`);
      }
      if (unreadableCount > 0) {
        parts.push(`${unreadableCount} unreadable (not imported)`);
      }
      setImportStatus(`Import complete: ${parts.join(", ")}.`);
      await updateGnucashBookState({ lastImportAt: new Date().toISOString() });
      setImportStep("done");
    } catch (error) {
      setImportError(toUiErrorMessage(error));
    } finally {
      setImportCommitting(false);
    }
  }

  async function loadExportPayments() {
    setExportError(null);
    setExportLoading(true);
    try {
      const [payments, accounts, categories] = await Promise.all([
        listExportablePayments(db, {
          fromDate: exportFrom,
          toDate: exportTo,
          includeExported,
        }),
        repos.accounts.list({ includeArchived: true }),
        repos.categories.list({ includeArchived: true }),
      ]);
      setExportPayments(payments);
      setFinAccounts(accounts);
      setFinCategories(categories);
      if (bookPath !== null && probe?.status === "ok") {
        setGnucashAccounts(await gnucashListAccounts(bookPath));
      }
    } catch (error) {
      setExportError(toUiErrorMessage(error));
    } finally {
      setExportLoading(false);
    }
  }

  async function runExport() {
    if (exportPayments.length === 0 || exportBlockers.length > 0) return;
    setExportError(null);
    setExportStatus(null);
    setExportBusy(true);
    try {
      const [accounts, categories, allPayees, gcAccounts] = await Promise.all([
        repos.accounts.list({ includeArchived: true }),
        repos.categories.list({ includeArchived: true }),
        repos.payees.list({ includeArchived: true }),
        bookPath !== null ? gnucashListAccounts(bookPath) : Promise.resolve(gnucashAccounts),
      ]);
      const buildInput = {
        payments: exportPayments,
        accounts,
        categories,
        gnucashAccounts: gcAccounts,
        payees: allPayees,
      };
      const content = exportFormat === "qif" ? buildQif(buildInput) : buildCsv(buildInput);
      const defaultPath = `gnucash-export.${exportFormat}`;
      const path =
        pickSavePath !== undefined
          ? await pickSavePath(defaultPath)
          : ((await save({
              title: "Save GnuCash export",
              defaultPath,
              filters: [{ name: exportFormat.toUpperCase(), extensions: [exportFormat] }],
            })) as string | null);

      if (!path) {
        return;
      }

      await exportReportCsv(path, content);
      await recordExport(
        db,
        exportPayments.map((payment) => payment.id),
        exportFormat,
      );
      setExportStatus(
        `Exported ${exportPayments.length} payment(s) as ${exportFormat.toUpperCase()} to ${path}.`,
      );
      await loadExportPayments();
    } catch (error) {
      setExportError(exportWriteErrorMessage(error));
    } finally {
      setExportBusy(false);
    }
  }

  async function runReconcile() {
    if (bookPath === null) return;
    const accountId = Number.parseInt(reconcileAccountId, 10);
    if (!Number.isInteger(accountId)) {
      setReconcileError("Choose a fin-app account to reconcile.");
      return;
    }
    const account = finAccounts.find((entry) => entry.id === accountId);
    if (!account?.gnucash_guid) {
      setReconcileError("Selected account is not mapped to GnuCash.");
      return;
    }

    setReconcileError(null);
    setReconcileLoading(true);
    try {
      const [accounts, payments, list] = await Promise.all([
        repos.accounts.list({ includeArchived: true }),
        repos.payments.list({
          accountId,
          from: reconcileFrom,
          to: reconcileTo,
        }),
        gnucashListTransactions(bookPath, [account.gnucash_guid], reconcileFrom, reconcileTo),
      ]);
      setFinAccounts(accounts);
      const result = await reconcile(db, payments, list, { toleranceDays });
      setReconcileResult(result);
    } catch (error) {
      setReconcileError(toUiErrorMessage(error));
    } finally {
      setReconcileLoading(false);
    }
  }

  async function applyManualMatch() {
    const paymentId = Number.parseInt(manualMatchPaymentId, 10);
    if (!Number.isInteger(paymentId) || manualMatchTxnGuid.length === 0) {
      setReconcileError("Select both a fin-app payment and a GnuCash transaction to match.");
      return;
    }
    setReconcileBusy(true);
    setReconcileError(null);
    try {
      await setManualMatch(db, paymentId, manualMatchTxnGuid);
      await runReconcile();
      setManualMatchPaymentId("");
      setManualMatchTxnGuid("");
    } catch (error) {
      setReconcileError(toUiErrorMessage(error));
    } finally {
      setReconcileBusy(false);
    }
  }

  async function applyManualUnmatch(paymentId: number, txnGuid: string) {
    setReconcileBusy(true);
    setReconcileError(null);
    try {
      await setManualUnmatch(db, paymentId, txnGuid);
      await runReconcile();
    } catch (error) {
      setReconcileError(toUiErrorMessage(error));
    } finally {
      setReconcileBusy(false);
    }
  }

  function renderAccountTreeNodes(
    nodes: AccountTreeNode[],
    depth = 0,
    selectable = false,
  ): ReactNode {
    return nodes.map((node) => {
      const { account } = node;
      const isEligible =
        !account.placeholder && ACCOUNT_ELIGIBLE_TYPES.has(account.account_type);
      return (
        <div key={account.guid} style={{ marginLeft: `${depth * 1.25}rem` }}>
          {selectable && isEligible ? (
            <label>
              <input
                type="checkbox"
                checked={importAccountGuids.includes(account.guid)}
                onChange={(event) => toggleImportAccount(account.guid, event.currentTarget.checked)}
              />{" "}
              {account.full_path}
            </label>
          ) : (
            <span className={isEligible ? undefined : "muted"}>{account.full_path}</span>
          )}
          {node.children.length > 0
            ? renderAccountTreeNodes(node.children, depth + 1, selectable)
            : null}
        </div>
      );
    });
  }

  function renderDiffs(diffs: GnucashImportFieldDiff[]): ReactNode {
    return (
      <ul>
        {diffs.map((diff) => (
          <li key={`${diff.field}-${String(diff.existing)}-${String(diff.incoming)}`}>
            {diff.field}: {formatDiffValue(diff.field, diff.existing)} →{" "}
            {formatDiffValue(diff.field, diff.incoming)}
          </li>
        ))}
      </ul>
    );
  }

  function renderBlockingPanel(): ReactNode {
    return (
      <div className="import-panel">
        <p className="error">{blockingReason}</p>
        <button type="button" className="primary" onClick={() => handleRelink()}>
          Re-link book
        </button>
      </div>
    );
  }

  function renderLinkTab(): ReactNode {
    return (
      <>
        <p className="muted">
          Link a GnuCash sqlite3 book for mapping, import, export, and reconcile. XML books must
          be converted first.
        </p>
        <div className="import-actions">
          <button
            type="button"
            className="primary"
            disabled={linkLoading || probing}
            onClick={() => void chooseBook()}
          >
            {linkLoading ? "Working…" : "Choose / re-link book"}
          </button>
        </div>
        {linkError !== null && <p className="error">{linkError}</p>}
        {linkNotice !== null && <p className="status">{linkNotice}</p>}
        {probing && <p className="muted">Probing linked book…</p>}
        {bookPath !== null && probe?.status === "ok" && (
          <section className="import-panel">
            <h2>Linked book</h2>
            <p>
              <strong>Path:</strong> {bookPath}
            </p>
            <p>
              <strong>Schema version:</strong> {probe.schemaVersion}
            </p>
            <p>
              <strong>Accounts:</strong> {accountCount ?? "—"}
            </p>
            {bookState?.lastImportAt !== null && bookState?.lastImportAt !== undefined && (
              <p className="muted">Last import: {bookState.lastImportAt}</p>
            )}
          </section>
        )}
        {bookPath !== null && probe !== null && probe.status !== "ok" && (
          <section className="import-panel">
            <p className="error">{probeBlockingMessage(probe)}</p>
          </section>
        )}
      </>
    );
  }

  function renderMappingTab(): ReactNode {
    if (blocked) return renderBlockingPanel();
    if (mappingLoading) return <p className="muted">Loading mappings…</p>;
    if (mappingError !== null) return <p className="error">{mappingError}</p>;

    const accountTargets = eligibleMappingAccounts(gnucashAccounts);
    const categoryTargets = eligibleMappingCategories(gnucashAccounts);

    return (
      <>
        {mappingActionError !== null && <p className="error">{mappingActionError}</p>}
        {(mappingWarnings.unmappedFinAccounts.length > 0 ||
          mappingWarnings.unmappedCategories.length > 0 ||
          mappingWarnings.unmappedGnucashAccounts.length > 0) && (
          <section className="import-panel">
            <h2>Unmapped warnings</h2>
            {mappingWarnings.unmappedFinAccounts.length > 0 && (
              <p>
                Unmapped fin-app accounts:{" "}
                {mappingWarnings.unmappedFinAccounts.map((account) => account.name).join(", ")}
              </p>
            )}
            {mappingWarnings.unmappedCategories.length > 0 && (
              <p>
                Unmapped categories:{" "}
                {mappingWarnings.unmappedCategories.map((category) => category.name).join(", ")}
              </p>
            )}
            {mappingWarnings.unmappedGnucashAccounts.length > 0 && (
              <p>
                Unmapped GnuCash accounts:{" "}
                {mappingWarnings.unmappedGnucashAccounts
                  .map((account) => account.full_path)
                  .join(", ")}
              </p>
            )}
          </section>
        )}

        {accountSuggestions.length > 0 && (
          <section className="import-panel">
            <h2>Account suggestions</h2>
            <table className="import-table">
              <thead>
                <tr>
                  <th>Fin account</th>
                  <th>GnuCash account</th>
                  <th>Reason</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {accountSuggestions.map((suggestion) => {
                  const finAccount = finAccounts.find(
                    (account) => account.id === suggestion.finEntityId,
                  );
                  const gcAccount = accountTargets.find(
                    (account) => account.guid === suggestion.gnucashGuid,
                  );
                  return (
                    <tr key={`account-suggestion-${suggestion.finEntityId}`}>
                      <td>{finAccount?.name ?? suggestion.finEntityId}</td>
                      <td>{gcAccount?.full_path ?? suggestion.gnucashGuid}</td>
                      <td>{suggestion.reason}</td>
                      <td>
                        <button
                          type="button"
                          disabled={mappingBusy}
                          onClick={() =>
                            void handleApplyAccountMapping(
                              suggestion.finEntityId,
                              suggestion.gnucashGuid,
                            )
                          }
                        >
                          Apply
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        <section className="import-panel">
          <h2>Fin-app accounts</h2>
          <table className="import-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Mapped GnuCash account</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {finAccounts.map((account) => (
                <tr key={`fin-account-${account.id}`}>
                  <td>{account.name}</td>
                  <td>
                    <select
                      value={account.gnucash_guid ?? ""}
                      onChange={(event) => {
                        const guid = event.currentTarget.value;
                        if (guid.length === 0) {
                          void handleClearMapping("account", account.id);
                        } else {
                          void handleApplyAccountMapping(account.id, guid);
                        }
                      }}
                      disabled={mappingBusy}
                    >
                      <option value="">— unmapped —</option>
                      {accountTargets.map((target) => (
                        <option key={target.guid} value={target.guid}>
                          {target.full_path}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {account.gnucash_guid !== null && (
                      <button
                        type="button"
                        disabled={mappingBusy}
                        onClick={() => void handleClearMapping("account", account.id)}
                      >
                        Clear
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {categorySuggestions.length > 0 && (
          <section className="import-panel">
            <h2>Category suggestions</h2>
            <table className="import-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>GnuCash expense</th>
                  <th>Reason</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {categorySuggestions.map((suggestion) => {
                  const category = finCategories.find(
                    (entry) => entry.id === suggestion.finEntityId,
                  );
                  const gcAccount = categoryTargets.find(
                    (account) => account.guid === suggestion.gnucashGuid,
                  );
                  return (
                    <tr key={`category-suggestion-${suggestion.finEntityId}`}>
                      <td>{category?.name ?? suggestion.finEntityId}</td>
                      <td>{gcAccount?.full_path ?? suggestion.gnucashGuid}</td>
                      <td>{suggestion.reason}</td>
                      <td>
                        <button
                          type="button"
                          disabled={mappingBusy}
                          onClick={() =>
                            void handleApplyCategoryMapping(
                              suggestion.finEntityId,
                              suggestion.gnucashGuid,
                            )
                          }
                        >
                          Apply
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        <section className="import-panel">
          <h2>Categories</h2>
          <table className="import-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Mapped GnuCash expense</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {finCategories.map((category) => (
                <tr key={`fin-category-${category.id}`}>
                  <td>{category.name}</td>
                  <td>
                    <select
                      value={category.gnucash_guid ?? ""}
                      onChange={(event) => {
                        const guid = event.currentTarget.value;
                        if (guid.length === 0) {
                          void handleClearMapping("category", category.id);
                        } else {
                          void handleApplyCategoryMapping(category.id, guid);
                        }
                      }}
                      disabled={mappingBusy}
                    >
                      <option value="">— unmapped —</option>
                      {categoryTargets.map((target) => (
                        <option key={target.guid} value={target.guid}>
                          {target.full_path}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {category.gnucash_guid !== null && (
                      <button
                        type="button"
                        disabled={mappingBusy}
                        onClick={() => void handleClearMapping("category", category.id)}
                      >
                        Clear
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="import-panel">
          <h2>GnuCash account tree</h2>
          {renderAccountTreeNodes(buildAccountTree(gnucashAccounts))}
        </section>
      </>
    );
  }

  function renderImportTab(): ReactNode {
    if (blocked) return renderBlockingPanel();

    if (importStep === "setup") {
      return (
        <>
          <p className="muted">Select GnuCash accounts and a date window, then plan the import.</p>
          <div className="reports-filters">
            <label className="field">
              From
              <input
                aria-label="Import from date"
                type="date"
                value={importFrom}
                onChange={(event) => setImportFrom(event.currentTarget.value)}
              />
            </label>
            <label className="field">
              To
              <input
                aria-label="Import to date"
                type="date"
                value={importTo}
                onChange={(event) => setImportTo(event.currentTarget.value)}
              />
            </label>
          </div>
          <section className="import-panel">
            <h2>Import accounts</h2>
            {importTree.length === 0 ? (
              <p className="muted">No eligible GnuCash accounts loaded.</p>
            ) : (
              renderAccountTreeNodes(importTree, 0, true)
            )}
          </section>
          <div className="import-actions">
            <button
              type="button"
              className="primary"
              disabled={importLoading || importAccountGuids.length === 0}
              onClick={() => void planImport()}
            >
              {importLoading ? "Planning import…" : "Plan import"}
            </button>
          </div>
          {importError !== null && <p className="error">{importError}</p>}
        </>
      );
    }

    if (!importPlan) {
      return <p className="muted">No import plan loaded.</p>;
    }

    const payeeChoicesNeeded = importPlan.new.filter(
      (row) => row.payeeCreateSuggestion !== undefined && confirmedPayeeIds[row.txnGuid] === undefined,
    );

    return (
      <>
        {importError !== null && <p className="error">{importError}</p>}
        {importStatus !== null && <p className="status">{importStatus}</p>}

        {importPlan.new.length > 0 && (
          <section className="import-panel">
            <h2>New ({importPlan.new.length})</h2>
            <table className="import-table">
              <thead>
                <tr>
                  <th>Approve</th>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Memo</th>
                  <th>Payee</th>
                </tr>
              </thead>
              <tbody>
                {importPlan.new.map((row) => (
                  <tr key={`import-new-${row.txnGuid}`}>
                    <td>
                      <input
                        type="checkbox"
                        checked={approvedNew.has(row.txnGuid)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setApprovedNew((current) => {
                            const next = new Set(current);
                            if (checked) next.add(row.txnGuid);
                            else next.delete(row.txnGuid);
                            return next;
                          });
                        }}
                      />
                    </td>
                    <td>{row.date}</td>
                    <td>{toCurrency(row.amount_cents)}</td>
                    <td>{row.memo}</td>
                    <td>
                      {row.payeeCreateSuggestion !== undefined ? (
                        <>
                          <span>Suggested: {row.payeeCreateSuggestion}</span>
                          <div className="import-actions">
                            <button
                              type="button"
                              disabled={importCommitting}
                              onClick={() =>
                                void confirmCreatePayee(row.txnGuid, row.payeeCreateSuggestion!)
                              }
                            >
                              Create payee
                            </button>
                            <select
                              value={confirmedPayeeIds[row.txnGuid]?.toString() ?? ""}
                              onChange={(event) => {
                                const id = Number.parseInt(event.currentTarget.value, 10);
                                if (Number.isInteger(id)) {
                                  setConfirmedPayeeIds((current) => ({
                                    ...current,
                                    [row.txnGuid]: id,
                                  }));
                                }
                              }}
                            >
                              <option value="">Use existing payee…</option>
                              {payees.map((payee) => (
                                <option key={payee.id} value={String(payee.id)}>
                                  {payee.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        </>
                      ) : (
                        <span className="muted">Existing payee</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {importPlan.updated.length > 0 && (
          <section className="import-panel">
            <h2>Updated ({importPlan.updated.length})</h2>
            <table className="import-table">
              <thead>
                <tr>
                  <th>Decision</th>
                  <th>Payment</th>
                  <th>Changes</th>
                </tr>
              </thead>
              <tbody>
                {importPlan.updated.map((row) => (
                  <tr key={`import-updated-${row.txnGuid}`}>
                    <td>
                      <button
                        type="button"
                        className={approvedUpdates.has(row.txnGuid) ? "primary" : undefined}
                        onClick={() =>
                          setApprovedUpdates((current) => new Set(current).add(row.txnGuid))
                        }
                      >
                        Approve
                      </button>{" "}
                      <button
                        type="button"
                        onClick={() =>
                          setApprovedUpdates((current) => {
                            const next = new Set(current);
                            next.delete(row.txnGuid);
                            return next;
                          })
                        }
                      >
                        Reject
                      </button>
                    </td>
                    <td>#{row.paymentId}</td>
                    <td>{renderDiffs(row.diffs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {importPlan.mergeCandidates.length > 0 && (
          <section className="import-panel">
            <h2>Merge candidates ({importPlan.mergeCandidates.length})</h2>
            <table className="import-table">
              <thead>
                <tr>
                  <th>Decision</th>
                  <th>Payment</th>
                  <th>Txn GUID</th>
                </tr>
              </thead>
              <tbody>
                {importPlan.mergeCandidates.map((row) => (
                  <tr key={`import-merge-${row.txnGuid}`}>
                    <td>
                      <button
                        type="button"
                        className={approvedMerges.has(row.txnGuid) ? "primary" : undefined}
                        onClick={() =>
                          setApprovedMerges((current) => new Set(current).add(row.txnGuid))
                        }
                      >
                        Approve
                      </button>{" "}
                      <button
                        type="button"
                        onClick={() =>
                          setApprovedMerges((current) => {
                            const next = new Set(current);
                            next.delete(row.txnGuid);
                            return next;
                          })
                        }
                      >
                        Reject
                      </button>
                    </td>
                    <td>#{row.paymentId}</td>
                    <td>{row.txnGuid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {importPlan.unmappable.length > 0 && (
          <section className="import-panel">
            <h2>Unmappable ({importPlan.unmappable.length})</h2>
            <table className="import-table">
              <thead>
                <tr>
                  <th>Txn GUID</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {importPlan.unmappable.map((row) => (
                  <tr key={`import-unmappable-${row.txnGuid}`}>
                    <td>{row.txnGuid}</td>
                    <td>{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {importPlan.unreadable.length > 0 && (
          <section className="import-panel">
            <h2>Unreadable ({importPlan.unreadable.length})</h2>
            <table className="import-table">
              <thead>
                <tr>
                  <th>Txn GUID</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {importPlan.unreadable.map((row) => (
                  <tr key={`import-unreadable-${row.error.txn_guid}`}>
                    <td>{row.error.txn_guid}</td>
                    <td>{row.error.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {payeeChoicesNeeded.length > 0 && (
          <p className="error">
            Confirm or select a payee for {payeeChoicesNeeded.length} new row(s) before commit.
          </p>
        )}

        <div className="import-actions">
          <button type="button" disabled={importCommitting} onClick={() => setImportStep("setup")}>
            Back
          </button>
          <button
            type="button"
            className="primary"
            disabled={
              importCommitting ||
              payeeChoicesNeeded.some(
                (row) => approvedNew.has(row.txnGuid) && confirmedPayeeIds[row.txnGuid] === undefined,
              )
            }
            onClick={() => void commitImport()}
          >
            {importCommitting ? "Committing…" : "Commit import"}
          </button>
        </div>
      </>
    );
  }

  function renderExportTab(): ReactNode {
    if (blocked) return renderBlockingPanel();

    return (
      <>
        <p className="muted">Export fin-app payments to QIF or CSV for GnuCash.</p>
        <div className="reports-filters">
          <label className="field">
            From
            <input
              aria-label="Export from date"
              type="date"
              value={exportFrom}
              onChange={(event) => setExportFrom(event.currentTarget.value)}
            />
          </label>
          <label className="field">
            To
            <input
              aria-label="Export to date"
              type="date"
              value={exportTo}
              onChange={(event) => setExportTo(event.currentTarget.value)}
            />
          </label>
          <label className="field">
            Format
            <select
              aria-label="Export format"
              value={exportFormat}
              onChange={(event) => setExportFormat(event.currentTarget.value as "qif" | "csv")}
            >
              <option value="qif">QIF</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <label className="field">
            <input
              type="checkbox"
              checked={includeExported}
              onChange={(event) => setIncludeExported(event.currentTarget.checked)}
            />{" "}
            Include previously exported payments
          </label>
        </div>
        <div className="import-actions">
          <button
            type="button"
            disabled={exportLoading}
            onClick={() => void loadExportPayments()}
          >
            {exportLoading ? "Loading payments…" : "Load payments"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={
              exportBusy || exportLoading || exportPayments.length === 0 || exportBlockers.length > 0
            }
            onClick={() => void runExport()}
          >
            {exportBusy ? "Exporting…" : "Export"}
          </button>
        </div>
        {exportError !== null && <p className="error">{exportError}</p>}
        {exportStatus !== null && <p className="status">{exportStatus}</p>}
        {exportBlockers.length > 0 && (
          <section className="import-panel">
            <h2>Mapping blockers</h2>
            <ul>
              {exportBlockers.map((blocker) => (
                <li key={`export-blocker-${blocker.paymentId}`}>
                  Payment #{blocker.paymentId}: {blocker.reason}
                </li>
              ))}
            </ul>
          </section>
        )}
        {exportPayments.length > 0 && (
          <section className="import-panel">
            <h2>Payments ({exportPayments.length})</h2>
            <table className="import-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Memo</th>
                  <th>Exported</th>
                </tr>
              </thead>
              <tbody>
                {exportPayments.map((payment) => (
                  <tr key={`export-payment-${payment.id}`}>
                    <td>{payment.date}</td>
                    <td>{toCurrency(payment.amount_cents)}</td>
                    <td>{payment.memo ?? "—"}</td>
                    <td>
                      {payment.exportHistory.length > 0
                        ? payment.exportHistory
                            .map((entry) => `${entry.format} @ ${entry.exportedAt}`)
                            .join("; ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </>
    );
  }

  function renderReconcileTab(): ReactNode {
    if (blocked) return renderBlockingPanel();

    const summaries =
      reconcileResult !== null && reconcileAccountId.length > 0
        ? summarize(reconcileResult).filter(
            (entry) => entry.accountId === Number.parseInt(reconcileAccountId, 10),
          )
        : [];

    return (
      <>
        <p className="muted">Compare fin-app payments with GnuCash transactions for a mapped account.</p>
        <div className="reports-filters">
          <label className="field">
            Account
            <select
              aria-label="Reconcile account"
              value={reconcileAccountId}
              onChange={(event) => setReconcileAccountId(event.currentTarget.value)}
            >
              <option value="">Choose account…</option>
              {mappedAccounts.map((account) => (
                <option key={account.id} value={String(account.id)}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            From
            <input
              aria-label="Reconcile from date"
              type="date"
              value={reconcileFrom}
              onChange={(event) => setReconcileFrom(event.currentTarget.value)}
            />
          </label>
          <label className="field">
            To
            <input
              aria-label="Reconcile to date"
              type="date"
              value={reconcileTo}
              onChange={(event) => setReconcileTo(event.currentTarget.value)}
            />
          </label>
          <label className="field">
            Tolerance (± days)
            <input
              aria-label="Reconcile tolerance days"
              type="number"
              min={0}
              value={toleranceDays}
              onChange={(event) => {
                const next = Number.parseInt(event.currentTarget.value, 10);
                if (Number.isInteger(next) && next >= 0) setToleranceDays(next);
              }}
            />
          </label>
        </div>
        <div className="import-actions">
          <button
            type="button"
            className="primary"
            disabled={reconcileLoading || reconcileBusy}
            onClick={() => void runReconcile()}
          >
            {reconcileLoading ? "Running reconcile…" : "Run reconcile"}
          </button>
        </div>
        {reconcileError !== null && <p className="error">{reconcileError}</p>}

        {summaries.map((summary) => (
          <p key={`reconcile-summary-${summary.accountId}`} className="status">
            Matched {summary.matchedCount} ({toCurrency(summary.matchedTotalCents)}), fin-app only{" "}
            {summary.finAppOnlyCount} ({toCurrency(summary.finAppOnlyTotalCents)}), GnuCash only{" "}
            {summary.gnucashOnlyCount} ({toCurrency(summary.gnucashOnlyTotalCents)})
          </p>
        ))}

        {reconcileResult !== null && reconcileResult.readerErrors.length > 0 && (
          <section className="import-panel">
            <h2>Reader errors</h2>
            <ul>
              {reconcileResult.readerErrors.map((error) => (
                <li key={`reconcile-reader-${error.txn_guid}`}>
                  {error.txn_guid}: {error.reason}
                </li>
              ))}
            </ul>
          </section>
        )}

        {reconcileResult !== null && (
          <>
            <section className="import-panel">
              <h2>Matched ({reconcileResult.matched.length})</h2>
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>GnuCash txn</th>
                    <th>Amount</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {reconcileResult.matched.map((pair) => (
                    <tr key={`matched-${pair.payment.id}-${pair.transaction.txn_guid}`}>
                      <td>
                        #{pair.payment.id} {pair.payment.date}
                      </td>
                      <td>
                        {pair.transaction.txn_guid} {pair.transaction.post_date}
                      </td>
                      <td>{toCurrency(pair.payment.amount_cents)}</td>
                      <td>
                        <button
                          type="button"
                          disabled={reconcileBusy}
                          onClick={() =>
                            void applyManualUnmatch(pair.payment.id, pair.transaction.txn_guid)
                          }
                        >
                          Unmatch
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="import-panel">
              <h2>Fin-app only ({reconcileResult.finAppOnly.length})</h2>
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>Date</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {reconcileResult.finAppOnly.map((payment) => (
                    <tr key={`fin-only-${payment.id}`}>
                      <td>#{payment.id}</td>
                      <td>{payment.date}</td>
                      <td>{toCurrency(payment.amount_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="import-panel">
              <h2>GnuCash only ({reconcileResult.gnucashOnly.length})</h2>
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Txn GUID</th>
                    <th>Date</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {reconcileResult.gnucashOnly.map((txn) => (
                    <tr key={`gc-only-${txn.txn_guid}`}>
                      <td>{txn.txn_guid}</td>
                      <td>{txn.post_date}</td>
                      <td>{txn.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="import-panel">
              <h2>Manual match</h2>
              <div className="reports-filters">
                <label className="field">
                  Fin-app payment
                  <select
                    aria-label="Manual match payment"
                    value={manualMatchPaymentId}
                    onChange={(event) => setManualMatchPaymentId(event.currentTarget.value)}
                  >
                    <option value="">Choose payment…</option>
                    {reconcileResult.finAppOnly.map((payment) => (
                      <option key={`manual-payment-${payment.id}`} value={String(payment.id)}>
                        #{payment.id} {payment.date} {toCurrency(payment.amount_cents)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  GnuCash transaction
                  <select
                    aria-label="Manual match transaction"
                    value={manualMatchTxnGuid}
                    onChange={(event) => setManualMatchTxnGuid(event.currentTarget.value)}
                  >
                    <option value="">Choose transaction…</option>
                    {reconcileResult.gnucashOnly.map((txn) => (
                      <option key={`manual-txn-${txn.txn_guid}`} value={txn.txn_guid}>
                        {txn.txn_guid} {txn.post_date}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                type="button"
                className="primary"
                disabled={reconcileBusy}
                onClick={() => void applyManualMatch()}
              >
                Match selected
              </button>
            </section>
          </>
        )}
      </>
    );
  }

  function renderActiveTab(): ReactNode {
    switch (tab) {
      case "link":
        return renderLinkTab();
      case "mapping":
        return renderMappingTab();
      case "import":
        return renderImportTab();
      case "export":
        return renderExportTab();
      case "reconcile":
        return renderReconcileTab();
    }
  }

  return (
    <section className="page">
      <h1>GnuCash</h1>
      <p className="muted">Link your GnuCash book, map accounts, import, export, and reconcile.</p>

      <div className="import-actions" role="tablist" aria-label="GnuCash sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? "primary" : undefined}
            onClick={() => handleTabChange(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {renderActiveTab()}
    </section>
  );
}
