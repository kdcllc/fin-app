/**
 * First-run screen: pick where the book (SQLite file) lives. Offers a
 * directory picker for a user-visible, easy-to-back-up folder, with the app
 * config dir as the default fallback. If a book file already exists in the
 * chosen folder it is opened as-is (no copy/move).
 */
import { useEffect, useState } from "react";
import { appConfigDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { BOOK_FILE_NAME } from "./book";

interface FirstRunProps {
  /** Called with the absolute book file path once the user has chosen. */
  onChoose: (bookPath: string) => Promise<void>;
}

export function FirstRun({ onChoose }: FirstRunProps) {
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    appConfigDir()
      .then(setDefaultDir)
      .catch(() => setDefaultDir(null));
  }, []);

  async function choose(dir: string) {
    setBusy(true);
    setError(null);
    try {
      await onChoose(await join(dir, BOOK_FILE_NAME));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function pickFolder() {
    setError(null);
    const dir = await open({
      directory: true,
      title: "Choose a folder for your book",
    });
    if (typeof dir === "string") {
      await choose(dir);
    }
  }

  return (
    <div className="first-run">
      <div className="first-run-card">
        <h1>Welcome to fin-app</h1>
        <p>
          Your book is a single SQLite file (<code>{BOOK_FILE_NAME}</code>) that holds all your
          data. Pick a folder that is easy to find and back up — for example Documents or a synced
          folder.
        </p>
        <p className="muted">
          If a book file already exists in the folder you pick, it is opened as-is.
        </p>
        <div className="first-run-actions">
          <button type="button" className="primary" onClick={pickFolder} disabled={busy}>
            Choose a folder…
          </button>
          <button
            type="button"
            onClick={() => defaultDir && choose(defaultDir)}
            disabled={busy || defaultDir === null}
          >
            Keep the current location
          </button>
        </div>
        {defaultDir !== null && (
          <p className="muted">
            Current location: <code>{defaultDir}</code>
          </p>
        )}
        {error !== null && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
