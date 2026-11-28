/**
 * App shell: first-run book-location flow, then sidebar navigation between
 * pages. Routing is a minimal hand-rolled page state — no router dependency.
 * Data access goes through the core public entry only (via `openBook`).
 */
import { useCallback, useEffect, useState } from "react";
import type { Database, Repositories } from "./core";
import { openBook } from "./book";
import { runScheduledBackupIfDue } from "./backup";
import { checkForUpdate } from "./updater";
import { FirstRun } from "./FirstRun";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { ImportPage } from "./pages/ImportPage";
import { SettingsPage } from "./pages/SettingsPage";
import { EntityManagementPage } from "./pages/EntityManagementPage";
import { PaymentsPage } from "./pages/PaymentsPage";
import { BillsGridPage } from "./pages/BillsGridPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ReportsPage } from "./pages/ReportsPage";
import { GnuCashPage } from "./pages/GnuCashPage";
import { AccountsPage } from "./pages/AccountsPage";
import { RegisterPage } from "./pages/RegisterPage";
import { loadSettings, updateSettings, type AppSettings } from "./settings";
import "./App.css";

type PageId =
  | "dashboard"
  | "accounts"
  | "register"
  | "bills"
  | "payments"
  | "reports"
  | "import"
  | "entities"
  | "gnucash"
  | "settings";

const PAGES: { id: PageId; label: string; blurb: string }[] = [
  { id: "dashboard", label: "Dashboard", blurb: "Month-at-a-glance overview of your bills." },
  { id: "accounts", label: "Accounts", blurb: "Your account tree and balances." },
  { id: "register", label: "Register", blurb: "Account register with running balance." },
  { id: "bills", label: "Bills Grid", blurb: "The yearly bills-by-month grid." },
  { id: "payments", label: "Payments", blurb: "Record and browse bill payments." },
  { id: "reports", label: "Reports", blurb: "Spending summaries and printable reports." },
  { id: "import", label: "Import", blurb: "Import your bill-pay spreadsheet." },
  { id: "entities", label: "Manage Entities", blurb: "Manage payees, accounts, and categories." },
  { id: "gnucash", label: "GnuCash", blurb: "Import from your GnuCash book." },
  { id: "settings", label: "Settings", blurb: "" },
];

type Phase =
  | { kind: "loading" }
  | { kind: "first-run" }
  | { kind: "error"; message: string }
  | { kind: "ready"; settings: AppSettings; db: Database; repos: Repositories };

let scheduledBackupSessionStarted = false;
let updateCheckSessionStarted = false;

function triggerScheduledBackupOnce(
  settings: AppSettings,
  callbacks: {
    onFailure: (message: string) => void;
    onSettingsRefresh: (settings: AppSettings) => void;
  },
): void {
  if (scheduledBackupSessionStarted) {
    return;
  }
  scheduledBackupSessionStarted = true;
  void runScheduledBackupIfDue(settings).then(async (outcome) => {
    if (outcome.status === "failed") {
      callbacks.onFailure(outcome.error);
      return;
    }
    if (outcome.status === "ran") {
      const fresh = await loadSettings();
      callbacks.onSettingsRefresh(fresh);
    }
  });
}

function triggerUpdateCheckOnce(onAvailable: (version: string) => void): void {
  if (updateCheckSessionStarted) {
    return;
  }
  updateCheckSessionStarted = true;
  void checkForUpdate()
    .then((result) => {
      if (result.status === "available") {
        onAvailable(result.version);
        return;
      }
      if (result.status === "error") {
        console.warn("Update check failed:", result.message);
      }
    })
    .catch((error: unknown) => {
      console.warn(
        "Update check failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
}

function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [page, setPage] = useState<PageId>("dashboard");
  const [registerAccountId, setRegisterAccountId] = useState<number | undefined>(undefined);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const [appBusy, setAppBusy] = useState(false);

  const handleBusyChange = useCallback((busy: boolean) => {
    setAppBusy(busy);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settings = await loadSettings();
      if (settings.bookPath === null) {
        if (!cancelled) setPhase({ kind: "first-run" });
        return;
      }
      const { db, repos } = await openBook(settings.bookPath);
      if (!cancelled) {
        setPhase({ kind: "ready", settings, db, repos });
        triggerScheduledBackupOnce(settings, {
          onFailure: setBackupNotice,
          onSettingsRefresh: (fresh) => {
            setPhase((current) =>
              current.kind === "ready" ? { ...current, settings: fresh } : current,
            );
          },
        });
        triggerUpdateCheckOnce((version) => {
          setUpdateNotice(version);
        });
      }
    })().catch((e: unknown) => {
      if (!cancelled) {
        setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleFirstRunChoice(bookPath: string) {
    const settings = await updateSettings({ bookPath });
    const { db, repos } = await openBook(bookPath);
    setPhase({ kind: "ready", settings, db, repos });
    triggerScheduledBackupOnce(settings, {
      onFailure: setBackupNotice,
      onSettingsRefresh: (fresh) => {
        setPhase((current) =>
          current.kind === "ready" ? { ...current, settings: fresh } : current,
        );
      },
    });
    triggerUpdateCheckOnce((version) => {
      setUpdateNotice(version);
    });
  }

  async function handleSettingsUpdate(patch: Partial<AppSettings>) {
    const settings = await updateSettings(patch);
    setPhase((current) => (current.kind === "ready" ? { ...current, settings } : current));
  }

  if (phase.kind === "loading") {
    return <div className="centered muted">Opening your book…</div>;
  }
  if (phase.kind === "first-run") {
    return <FirstRun onChoose={handleFirstRunChoice} />;
  }
  if (phase.kind === "error") {
    return (
      <div className="centered">
        <p className="error">Could not open the book: {phase.message}</p>
      </div>
    );
  }

  function handleOpenRegister(accountId: number) {
    setRegisterAccountId(accountId);
    setPage("register");
  }

  const active = PAGES.find((p) => p.id === page) ?? PAGES[0];
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">fin-app</div>
        <nav>
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={p.id === page ? "nav-item active" : "nav-item"}
              aria-current={p.id === page ? "page" : undefined}
              onClick={() => setPage(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="content">
        {backupNotice !== null && (
          <div role="status">
            <p className="error">Automatic backup failed: {backupNotice}</p>
            <button type="button" onClick={() => setBackupNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        {updateNotice !== null && (
          <div role="status">
            <p>
              Update <strong>{updateNotice}</strong> is available. Open Settings → Updates to
              download and install.
            </p>
            <button type="button" onClick={() => setPage("settings")}>
              Go to Settings
            </button>{" "}
            <button type="button" onClick={() => setUpdateNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        {active.id === "settings" ? (
          <SettingsPage
            settings={phase.settings}
            onUpdate={handleSettingsUpdate}
            appBusy={appBusy}
            onBusyChange={handleBusyChange}
          />
        ) : active.id === "dashboard" ? (
          <DashboardPage repos={phase.repos} initialYear={phase.settings.defaultYear ?? undefined} />
        ) : active.id === "accounts" ? (
          <AccountsPage repos={phase.repos} onOpenRegister={handleOpenRegister} />
        ) : active.id === "register" ? (
          <RegisterPage repos={phase.repos} initialAccountId={registerAccountId} />
        ) : active.id === "entities" ? (
          <EntityManagementPage repos={phase.repos} />
        ) : active.id === "payments" ? (
          <PaymentsPage repos={phase.repos} />
        ) : active.id === "bills" ? (
          <BillsGridPage repos={phase.repos} />
        ) : active.id === "import" ? (
          <ImportPage repos={phase.repos} onBusyChange={handleBusyChange} />
        ) : active.id === "reports" ? (
          <ReportsPage repos={phase.repos} />
        ) : active.id === "gnucash" ? (
          <GnuCashPage db={phase.db} repos={phase.repos} />
        ) : (
          <PlaceholderPage title={active.label} blurb={active.blurb} />
        )}
      </main>
    </div>
  );
}

export default App;
