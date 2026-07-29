import { invoke } from "@tauri-apps/api/core";

export interface RawCellData {
  row: number;
  col: number;
  value: string;
}

export interface RawSheetData {
  name: string;
  rows: string[][];
  nonEmptyCells: RawCellData[];
}

export type WorkbookWarning = {
  kind: "skipped_non_year_sheet";
  sheet_name: string;
  reason: string;
};

export interface RawWorkbookPayload {
  sheets: RawSheetData[];
  warnings: WorkbookWarning[];
}

export type ReadWorkbookError =
  | { kind: "missing_file"; path: string }
  | { kind: "non_xlsx"; path: string }
  | { kind: "open_failed"; path: string; message: string }
  | { kind: "read_failed"; path: string; sheet_name: string; message: string };

/** Invoke Rust xlsx extraction and return raw sheet/cell payload for parser review flows. */
export async function readXlsxWorkbookRaw(path: string): Promise<RawWorkbookPayload> {
  return invoke<RawWorkbookPayload>("read_xlsx_workbook_raw", { path });
}
