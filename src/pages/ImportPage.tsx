import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  annotateImportRowsWithDedup,
  buildPayeeProposals,
  commitReviewedImport,
  DatabaseLockedError,
  normalizePayeeLabel,
  parsePaymentCells,
  type ImportLogEntry,
  type ImportReviewRow,
  type Repositories,
} from "../core";
import { readXlsxWorkbookRaw, type RawWorkbookPayload } from "../xlsx-reader";

interface ImportPageProps {
  repos: Repositories;
  pickWorkbookPath?: () => Promise<string | null>;
  readWorkbook?: (path: string) => Promise<RawWorkbookPayload>;
}

interface UnparsedReviewCell {
  id: string;
  sheet: string;
  row: number;
  col: number;
  payee_label: string;
  raw_text: string;
  edited_text: string;
  state: "pending" | "skipped" | "fixed";
  error: string | null;
}

type WizardStep = "pick" | "review" | "done";

function formatAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const centsPart = String(absolute % 100).padStart(2, "0");
  return `${sign}${dollars}.${centsPart}`;
}

function parseAmountToCents(raw: string): number | null {
  const cleaned = raw.trim();
  if (!/^[-+]?\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;

  const sign = cleaned.startsWith("-") ? -1 : 1;
  const unsigned = cleaned.replace(/^[+-]/, "");
  const [wholePart, fractionalPart = ""] = unsigned.split(".");

  const whole = Number.parseInt(wholePart, 10);
  if (!Number.isSafeInteger(whole)) return null;

  const paddedFraction = fractionalPart.length === 1 ? `${fractionalPart}0` : fractionalPart;
  const fraction = paddedFraction.length > 0 ? Number.parseInt(paddedFraction, 10) : 0;
  if (!Number.isSafeInteger(fraction)) return null;

  const amount = sign * (whole * 100 + fraction);
  return Number.isSafeInteger(amount) ? amount : null;
}

function rowCoordLabel(row: Pick<ImportReviewRow, "source_sheet" | "source_row" | "source_col" | "occurrence_index">): string {
  return `${row.source_sheet}!R${row.source_row}C${row.source_col}#${row.occurrence_index}`;
}

function unparsedCoordLabel(cell: Pick<UnparsedReviewCell, "sheet" | "row" | "col">): string {
  return `${cell.sheet}!R${cell.row}C${cell.col}`;
}

function toUiErrorMessage(error: unknown): string {
  if (error instanceof DatabaseLockedError) {
    return "Database is locked by another process or app window. Close other fin-app instances or SQLite tools using this book, then try again.";
  }
  return error instanceof Error ? error.message : String(error);
}

async function hashWorkbookSemanticPayload(payload: RawWorkbookPayload): Promise<string> {
  const source = JSON.stringify(payload);
  if (typeof crypto !== "undefined" && "subtle" in crypto) {
    const bytes = new TextEncoder().encode(source);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return source;
}

export function ImportPage({
  repos,
  pickWorkbookPath,
  readWorkbook = readXlsxWorkbookRaw,
}: ImportPageProps) {
  const [step, setStep] = useState<WizardStep>("pick");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [contentHash, setContentHash] = useState<string>("");
  const [rows, setRows] = useState<ImportReviewRow[]>([]);
  const [unparsedCells, setUnparsedCells] = useState<UnparsedReviewCell[]>([]);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [workbookWarnings, setWorkbookWarnings] = useState<string[]>([]);
  const [previousImportByHash, setPreviousImportByHash] = useState<ImportLogEntry | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unresolvedUnparsedCount = useMemo(
    () => unparsedCells.filter((cell) => cell.state === "pending").length,
    [unparsedCells],
  );

  const unresolvedPotentialDuplicates = useMemo(
    () =>
      rows.filter(
        (row) => row.dedup.kind === "potential_duplicate" && row.dedup.decision === null,
      ).length,
    [rows],
  );

  const rowValidationErrors = useMemo(
    () =>
      rows.filter(
        (row) =>
          row.payee_name.trim().length === 0 ||
          row.account_name.trim().length === 0 ||
          row.date.trim().length === 0 ||
          !Number.isInteger(row.amount_cents),
      ).length,
    [rows],
  );

  const commitDisabled =
    committing ||
    rows.length === 0 ||
    unresolvedUnparsedCount > 0 ||
    unresolvedPotentialDuplicates > 0 ||
    rowValidationErrors > 0;

  async function chooseWorkbook() {
    setError(null);
    setStatusMessage(null);
    setWorkbookWarnings([]);
    setPreviousImportByHash(null);
    setLoading(true);

    try {
      const chosenPath =
        pickWorkbookPath !== undefined
          ? await pickWorkbookPath()
          : ((await open({
              multiple: false,
              directory: false,
              title: "Choose workbook to import",
              filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
            })) as string | null);

      if (!chosenPath) {
        setLoading(false);
        return;
      }

      const payload = await readWorkbook(chosenPath);
      const semanticPayloadHash = await hashWorkbookSemanticPayload(payload);
      const nextContentHash = payload.fileSha256 || semanticPayloadHash;
      const priorImport = await repos.importLog.findLatestByContentHash(nextContentHash);
      const nextRows: ImportReviewRow[] = [];
      const nextUnparsed: UnparsedReviewCell[] = [];

      for (const sheet of payload.sheets) {
        for (const cell of sheet.nonEmptyCells) {
          if (cell.row <= 1 || cell.col <= 1) continue;

          const rowCells = sheet.rows[cell.row - 1] ?? [];
          const rawPayeeLabel = (rowCells[0] ?? "").trim();
          if (rawPayeeLabel.length === 0) {
            nextUnparsed.push({
              id: `${sheet.name}:${cell.row}:${cell.col}:missing-payee`,
              sheet: sheet.name,
              row: cell.row,
              col: cell.col,
              payee_label: "",
              raw_text: cell.value,
              edited_text: cell.value,
              state: "pending",
              error: "Missing payee label for non-empty payment cell. Skip or fix in source workbook.",
            });
            continue;
          }

          const normalized = normalizePayeeLabel(rawPayeeLabel);
          const parsed = parsePaymentCells([
            {
              sheet: sheet.name,
              row: cell.row,
              col: cell.col,
              text: cell.value,
            },
          ]);

          if (parsed.unparsed.length > 0) {
            const unparsed = parsed.unparsed[0];
            nextUnparsed.push({
              id: `${unparsed.sheet}:${unparsed.row}:${unparsed.col}`,
              sheet: unparsed.sheet,
              row: unparsed.row,
              col: unparsed.col,
              payee_label: rawPayeeLabel,
              raw_text: unparsed.raw_text,
              edited_text: unparsed.raw_text,
              state: "pending",
              error: null,
            });
            continue;
          }

          for (const record of parsed.parsed) {
            nextRows.push({
              id: `${record.sheet}:${record.row}:${record.col}:${record.occurrence_index}`,
              payee_name: normalized.payee,
              account_name:
                normalized.account_hint.payment_method ??
                (normalized.account_hint.last4 ? `Account ${normalized.account_hint.last4}` : "Checking"),
              account_kind: "checking",
              category_name: normalized.category_suggestion,
              date: record.date,
              amount_cents: record.amount_cents,
              source_sheet: record.sheet,
              source_row: record.row,
              source_col: record.col,
              occurrence_index: record.occurrence_index,
              memo: null,
              dedup: { kind: "new" },
            });
          }
        }
      }

      const dedupedRows = await annotateImportRowsWithDedup(repos, nextRows);

      const nextWorkbookWarnings = payload.warnings.map((warning) => {
        if (warning.kind === "skipped_non_year_sheet") {
          return `Skipped sheet "${warning.sheet_name}": ${warning.reason}.`;
        }
        return "Workbook warning detected during read.";
      });

      setRows(dedupedRows);
      setUnparsedCells(nextUnparsed);
      setFilePath(chosenPath);
      setContentHash(nextContentHash);
      setWorkbookWarnings(nextWorkbookWarnings);
      setPreviousImportByHash(priorImport);
      setStep("review");
    } catch (e) {
      setError(toUiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  function patchRow(id: string, patch: Partial<ImportReviewRow>) {
    setRows((current) =>
      current.map((row) => {
        if (row.id !== id) return row;
        return { ...row, ...patch };
      }),
    );
  }

  async function refreshDedup() {
    setRows((current) => current.map((row) => ({ ...row, dedup: { kind: "new" } })));
    const annotated = await annotateImportRowsWithDedup(repos, rows);
    setRows(annotated);
  }

  function markSkipUnparsed(id: string) {
    setUnparsedCells((current) =>
      current.map((cell) =>
        cell.id === id
          ? {
              ...cell,
              state: "skipped",
              error: null,
            }
          : cell,
      ),
    );
  }

  async function reparseUnparsed(id: string) {
    const target = unparsedCells.find((cell) => cell.id === id);
    if (!target) return;

    if (target.payee_label.trim().length === 0) {
      setUnparsedCells((current) =>
        current.map((cell) =>
          cell.id === id
            ? {
                ...cell,
                error: "Missing payee label for non-empty payment cell. Skip or fix in source workbook.",
              }
            : cell,
        ),
      );
      return;
    }

    const parsed = parsePaymentCells([
      {
        sheet: target.sheet,
        row: target.row,
        col: target.col,
        text: target.edited_text,
      },
    ]);

    if (parsed.unparsed.length > 0) {
      setUnparsedCells((current) =>
        current.map((cell) =>
          cell.id === id ? { ...cell, error: "Still unparsed. Use MM/DD $amount or skip." } : cell,
        ),
      );
      return;
    }

    const normalized = normalizePayeeLabel(target.payee_label);
    const insertedRows: ImportReviewRow[] = parsed.parsed.map((record) => ({
      id: `${record.sheet}:${record.row}:${record.col}:${record.occurrence_index}:fixed`,
      payee_name: normalized.payee,
      account_name:
        normalized.account_hint.payment_method ??
        (normalized.account_hint.last4 ? `Account ${normalized.account_hint.last4}` : "Checking"),
      account_kind: "checking",
      category_name: normalized.category_suggestion,
      date: record.date,
      amount_cents: record.amount_cents,
      source_sheet: record.sheet,
      source_row: record.row,
      source_col: record.col,
      occurrence_index: record.occurrence_index,
      memo: null,
      dedup: { kind: "new" },
    }));

    const deduped = await annotateImportRowsWithDedup(repos, [...rows, ...insertedRows]);
    setRows(deduped);

    setUnparsedCells((current) =>
      current.map((cell) =>
        cell.id === id
          ? {
              ...cell,
              state: "fixed",
              error: null,
            }
          : cell,
      ),
    );
  }

  async function commitImport() {
    if (!filePath) return;

    setError(null);
    setStatusMessage(null);
    setCommitting(true);
    try {
      const result = await commitReviewedImport(repos, {
        source_file: filePath,
        content_hash: contentHash,
        rows,
      });

      setStatusMessage(
        `Imported ${result.inserted_count} rows (${result.skipped_exact_duplicates} exact duplicates skipped, ${result.skipped_potential_duplicates} potential duplicates skipped).`,
      );
      setStep("done");
    } catch (e) {
      setError(toUiErrorMessage(e));
    } finally {
      setCommitting(false);
    }
  }

  const payeeProposals = useMemo(() => buildPayeeProposals(rows.map((row) => row.payee_name)), [rows]);

  return (
    <section className="page import-page">
      <h1>Import</h1>
      <p className="muted">Pick a workbook, review parsed rows, resolve issues, then commit atomically.</p>

      <div className="import-wizard">
        <ol>
          <li className={step === "pick" ? "active" : ""}>Pick file</li>
          <li className={step === "review" ? "active" : ""}>Review</li>
          <li className={step === "done" ? "active" : ""}>Commit</li>
        </ol>
      </div>

      <div className="import-actions">
        <button type="button" className="primary" disabled={loading || committing} onClick={() => void chooseWorkbook()}>
          {loading ? "Loading workbook…" : "Choose workbook"}
        </button>
        {step === "review" && (
          <button type="button" disabled={loading || committing} onClick={() => void refreshDedup()}>
            Refresh duplicate check
          </button>
        )}
        <button
          type="button"
          className="primary"
          disabled={commitDisabled}
          onClick={() => void commitImport()}
        >
          {committing ? "Committing…" : "Commit import"}
        </button>
      </div>

      {filePath && (
        <p>
          Workbook: <code>{filePath}</code>
        </p>
      )}

      {previousImportByHash !== null && (
        <p className="error">
          Warning: this exact workbook file hash was imported before (import #{previousImportByHash.id} at {previousImportByHash.imported_at} from {previousImportByHash.source_file}).
        </p>
      )}

      {workbookWarnings.map((warning) => (
        <p key={warning} className="error">
          Workbook warning: {warning}
        </p>
      ))}

      {unresolvedUnparsedCount > 0 && (
        <p className="error">{unresolvedUnparsedCount} unparsed cell(s) must be fixed or skipped before commit.</p>
      )}
      {unresolvedPotentialDuplicates > 0 && (
        <p className="error">{unresolvedPotentialDuplicates} potential duplicate row(s) require keep/skip decisions.</p>
      )}
      {rowValidationErrors > 0 && <p className="error">{rowValidationErrors} row(s) have invalid required fields.</p>}

      {unparsedCells.length > 0 && (
        <section className="import-panel">
          <h2>Unparsed cells</h2>
          <table className="import-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Payee label</th>
                <th>Raw text</th>
                <th>Fix</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {unparsedCells.map((cell) => (
                <tr key={cell.id}>
                  <td>{unparsedCoordLabel(cell)}</td>
                  <td>{cell.payee_label}</td>
                  <td>{cell.raw_text}</td>
                  <td>
                    <input
                      value={cell.edited_text}
                      disabled={cell.state !== "pending"}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setUnparsedCells((current) =>
                          current.map((entry) =>
                            entry.id === cell.id ? { ...entry, edited_text: value, error: null } : entry,
                          ),
                        );
                      }}
                    />
                    {cell.error && <div className="error">{cell.error}</div>}
                  </td>
                  <td>{cell.state}</td>
                  <td>
                    <button
                      type="button"
                      disabled={cell.state !== "pending"}
                      onClick={() => void reparseUnparsed(cell.id)}
                    >
                      Reparse
                    </button>
                    <button
                      type="button"
                      disabled={cell.state !== "pending"}
                      onClick={() => markSkipUnparsed(cell.id)}
                    >
                      Skip cell
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="import-panel">
        <h2>Editable payment rows</h2>
        <table className="import-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Payee</th>
              <th>Account</th>
              <th>Category</th>
              <th>Date</th>
              <th>Amount</th>
              <th>Duplicate review</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{rowCoordLabel(row)}</td>
                <td>
                  <input
                    value={row.payee_name}
                    onChange={(e) => patchRow(row.id, { payee_name: e.currentTarget.value })}
                  />
                </td>
                <td>
                  <input
                    value={row.account_name}
                    onChange={(e) => patchRow(row.id, { account_name: e.currentTarget.value })}
                  />
                </td>
                <td>
                  <input
                    value={row.category_name ?? ""}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      patchRow(row.id, { category_name: value.trim().length > 0 ? value : null });
                    }}
                  />
                </td>
                <td>
                  <input
                    type="date"
                    value={row.date}
                    onChange={(e) => patchRow(row.id, { date: e.currentTarget.value })}
                  />
                </td>
                <td>
                  <input
                    value={formatAmount(row.amount_cents)}
                    onChange={(e) => {
                      const parsed = parseAmountToCents(e.currentTarget.value);
                      if (parsed !== null) {
                        patchRow(row.id, { amount_cents: parsed });
                      }
                    }}
                  />
                </td>
                <td>
                  {row.dedup.kind === "new" && <span>new</span>}
                  {row.dedup.kind === "exact_duplicate" && <span>exact duplicate (auto-skip)</span>}
                  {row.dedup.kind === "potential_duplicate" && (
                    <label>
                      {row.dedup.match_count} similar row(s)
                      <select
                        value={row.dedup.decision ?? ""}
                        onChange={(e) => {
                          const decision = e.currentTarget.value;
                          patchRow(row.id, {
                            dedup: {
                              kind: "potential_duplicate",
                              match_count: row.dedup.match_count,
                              decision: decision === "keep" || decision === "skip" ? decision : null,
                            },
                          });
                        }}
                      >
                        <option value="">choose…</option>
                        <option value="keep">keep row</option>
                        <option value="skip">skip row</option>
                      </select>
                    </label>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No parsed rows yet. Pick a workbook to begin.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {payeeProposals.length > 0 && (
        <section className="import-panel">
          <h2>Payee normalization preview</h2>
          <ul className="import-payee-proposals">
            {payeeProposals.map((proposal) => (
              <li key={proposal.payee}>
                <strong>{proposal.payee}</strong> ({proposal.labels.length} label variant(s))
              </li>
            ))}
          </ul>
        </section>
      )}

      {statusMessage !== null && <p>{statusMessage}</p>}
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}
