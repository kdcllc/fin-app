/**
 * Persisted GnuCash book link state and typed Tauri invoke wrappers for the
 * GnuCash reader commands. State lives in `gnucash.json` (not `settings.json`).
 */
import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { GnucashAccount, GnucashBookProbe, GnucashTransactionList } from "./core";

export interface GnucashBookState {
  /** Absolute path to the linked GnuCash book file; null when unlinked. */
  bookPath: string | null;
  /** Remembered import-account selection (GnuCash account GUIDs). */
  importAccountGuids: string[];
  /** ISO timestamp of the last successful import; null when never imported. */
  lastImportAt: string | null;
}

const store = new LazyStore("gnucash.json");

export async function loadGnucashBookState(): Promise<GnucashBookState> {
  const [bookPath, importAccountGuids, lastImportAt] = await Promise.all([
    store.get<string>("bookPath"),
    store.get<string[]>("importAccountGuids"),
    store.get<string>("lastImportAt"),
  ]);
  return {
    bookPath: bookPath ?? null,
    importAccountGuids: importAccountGuids ?? [],
    lastImportAt: lastImportAt ?? null,
  };
}

/** Persist the given fields (null clears a scalar field) and return fresh state. */
export async function updateGnucashBookState(
  patch: Partial<GnucashBookState>,
): Promise<GnucashBookState> {
  if (patch.bookPath !== undefined) {
    await setOrClear("bookPath", patch.bookPath);
  }
  if (patch.importAccountGuids !== undefined) {
    await store.set("importAccountGuids", patch.importAccountGuids);
  }
  if (patch.lastImportAt !== undefined) {
    await setOrClear("lastImportAt", patch.lastImportAt);
  }
  await store.save();
  return loadGnucashBookState();
}

async function setOrClear(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await store.delete(key);
  } else {
    await store.set(key, value);
  }
}

export async function gnucashProbeBook(path: string): Promise<GnucashBookProbe> {
  return invoke<GnucashBookProbe>("gnucash_probe_book", { path });
}

export async function gnucashListAccounts(path: string): Promise<GnucashAccount[]> {
  return invoke<GnucashAccount[]>("gnucash_list_accounts", { path });
}

export async function gnucashListTransactions(
  path: string,
  accountGuids: string[],
  from: string,
  to: string,
): Promise<GnucashTransactionList> {
  return invoke<GnucashTransactionList>("gnucash_list_transactions", {
    path,
    accountGuids,
    from,
    to,
  });
}
