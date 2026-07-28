/**
 * App shell: first-run book-location flow, then sidebar navigation between
 * pages. Routing is a minimal hand-rolled page state — no router dependency.
 * Data access goes through the core public entry only (via `openBook`).
 */
import { useEffect, useState } from "react";
import type { Repositories } from "./core";
import { openBook } from "./book";
import { FirstRun } from "./FirstRun";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { SettingsPage } from "./pages/SettingsPage";
import { loadSettings, updateSettings, type AppSettings } from "./settings";
import "./App.css";

type PageId = "dashboard" | "bills" | "payments" | "reports" | "import" | "gnucash" | "settings";

const PAGES: { id: PageId; label: string; blurb: string }[] = [
  { id: "dashboard", label: "Dashboard", blurb: "Month-at-a-glance overview of your bills." },
  { id: "bills", label: "Bills Grid", blurb: "The yearly bills-by-month grid." },
  { id: "payments", label: "Payments", blurb: "Record and browse bill payments." },
  { id: "reports", label: "Reports", blurb: "Spending summaries and printable reports." },
  { id: "import", label: "Import", blurb: "Import your bill-pay spreadsheet." },
  { id: "gnucash", label: "GnuCash", blurb: "Link payments to your GnuCash book." },
  { id: "settings", label: "Settings", blurb: "" },
];

type Phase =
  | { kind: "loading" }
  | { kind: "first-run" }
  | { kind: "error"; message: string }
  | { kind: "ready"; settings: AppSettings; repos: Repositories };

function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [page, setPage] = useState<PageId>("dashboard");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settings = await loadSettings();
      if (settings.bookPath === null) {
        if (!cancelled) setPhase({ kind: "first-run" });
        return;
      }
      const repos = await openBook(settings.bookPath);
      if (!cancelled) setPhase({ kind: "ready", settings, repos });
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
    const repos = await openBook(bookPath);
    setPhase({ kind: "ready", settings, repos });
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
        {active.id === "settings" ? (
          <SettingsPage settings={phase.settings} onUpdate={handleSettingsUpdate} />
        ) : (
          <PlaceholderPage title={active.label} blurb={active.blurb} />
        )}
      </main>
    </div>
  );
}

export default App;
