import { invoke } from "@tauri-apps/api/core";

export interface ReportPdfTableRow {
  label: string;
  totalCents: number;
  count: number;
}

export interface ReportPdfSpec {
  title: string;
  periodLabel: string;
  columnHeaders: string[];
  tableRows: ReportPdfTableRow[];
  chartPngBytes?: number[] | null;
}

export type ExportReportPdfError =
  | { kind: "write_failed"; path: string; message: string }
  | { kind: "invalid_chart_image"; message: string };

/** Invoke Rust PDF export for the current report table and optional chart image. */
export async function exportReportPdf(path: string, spec: ReportPdfSpec): Promise<void> {
  return invoke<void>("export_report_pdf", { path, spec });
}
