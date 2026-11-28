/**
 * IPC contract for `export_report_xlsx`: the exact `invoke` arguments the UI sends
 * are pinned in tests/fixtures/report/xlsx-ipc-payload.json. The Rust side
 * (src-tauri/src/report_xlsx.rs, `ipc_payload_fixture_*` tests) deserializes the
 * same file, so a field rename on either side fails one of the two suites.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import payload from "./fixtures/report/xlsx-ipc-payload.json";
import type { ReportPaymentRow, ReportRow } from "../src/core";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  buildPaymentsXlsxSpec,
  buildReportTableXlsxSpec,
  exportReportXlsx,
} from "../src/report-xlsx";

describe("export_report_xlsx IPC payload contract", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("sends the pinned payments payload", async () => {
    const payment = {
      date: "2026-02-14",
      payee_name: "Payee One",
      account_name: "Checking A",
      category_name: "Utilities",
      amount_cents: -4567,
      memo: "placeholder memo",
    } as ReportPaymentRow;

    await exportReportXlsx(payload.payments.path, buildPaymentsXlsxSpec([payment]));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("export_report_xlsx", payload.payments);
  });

  it("sends the pinned report-table payload", async () => {
    const row: ReportRow = {
      groupKey: 7,
      groupLabel: "Utilities",
      periodKey: "",
      total_cents: 12345,
      count: 3,
    };

    await exportReportXlsx(payload.table.path, buildReportTableXlsxSpec([row], false));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("export_report_xlsx", payload.table);
  });
});
