import { invoke } from "@tauri-apps/api/core";

export type ExportReportCsvError = {
  kind: "write_failed";
  path: string;
  message: string;
};

/** Write pre-formatted CSV (UTF-8 BOM) bytes via Rust. */
export async function exportReportCsv(path: string, content: string): Promise<void> {
  return invoke<void>("export_report_csv", { path, content });
}
