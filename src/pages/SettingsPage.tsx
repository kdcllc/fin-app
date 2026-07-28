/**
 * Settings page: book location (with "Open book folder"), default year, and
 * a backup-preferences placeholder. All values persist via the settings
 * store and survive restart.
 */
import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { AppSettings } from "../settings";

interface SettingsPageProps {
  settings: AppSettings;
  /** Persist a partial settings update. */
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsPage({ settings, onUpdate }: SettingsPageProps) {
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="page">
      <h1>Settings</h1>

      <h2>Book</h2>
      <p>
        Location: <code>{settings.bookPath ?? "(not set)"}</code>
      </p>
      <button
        type="button"
        disabled={settings.bookPath === null}
        onClick={() =>
          run(async () => {
            if (settings.bookPath !== null) {
              await revealItemInDir(settings.bookPath);
            }
          })
        }
      >
        Open book folder
      </button>

      <h2>Defaults</h2>
      <label className="field">
        Default year
        <input
          type="number"
          inputMode="numeric"
          placeholder="current year"
          value={settings.defaultYear ?? ""}
          onChange={(e) => {
            const raw = e.currentTarget.value;
            const year = raw === "" ? null : Number.parseInt(raw, 10);
            if (year === null || Number.isInteger(year)) {
              void run(() => onUpdate({ defaultYear: year }));
            }
          }}
        />
      </label>

      <h2>Backups</h2>
      <label className="field checkbox">
        <input
          type="checkbox"
          checked={settings.backups.enabled}
          onChange={(e) => {
            const enabled = e.currentTarget.checked;
            void run(() => onUpdate({ backups: { enabled } }));
          }}
        />
        Automatic backups (placeholder — arrives in a later milestone)
      </label>

      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}
