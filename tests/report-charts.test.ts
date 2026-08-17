import { describe, expect, it } from "vitest";
import {
  buildChartOption,
  chartThemeTokens,
  formatReportDollars,
} from "../src/pages/report-charts";
import type { ReportRow } from "../src/core";

const SAMPLE_ROWS: ReportRow[] = [
  {
    groupKey: 1,
    groupLabel: "Utilities",
    periodKey: "",
    total_cents: 12_345,
    count: 2,
  },
  {
    groupKey: 2,
    groupLabel: "Groceries",
    periodKey: "",
    total_cents: 5_000,
    count: 1,
  },
];

describe("formatReportDollars", () => {
  it("maps integer cents to a dollar string", () => {
    expect(formatReportDollars(12_345)).toBe("$123.45");
    expect(formatReportDollars(-12_345)).toBe("-$123.45");
    expect(formatReportDollars(0)).toBe("$0.00");
  });
});

describe("buildChartOption", () => {
  it("uses different theme tokens for light and dark", () => {
    const light = buildChartOption(SAMPLE_ROWS, { dimension: "category", grain: "all" }, "light");
    const dark = buildChartOption(SAMPLE_ROWS, { dimension: "category", grain: "all" }, "dark");

    expect(light.backgroundColor).toBe(chartThemeTokens("light").background);
    expect(dark.backgroundColor).toBe(chartThemeTokens("dark").background);
    expect(light.backgroundColor).not.toBe(dark.backgroundColor);
    expect(light.textStyle).toEqual({ color: chartThemeTokens("light").text });
    expect(dark.textStyle).toEqual({ color: chartThemeTokens("dark").text });
  });

  it("keeps series values as integer cents for category breakdown", () => {
    const option = buildChartOption(
      SAMPLE_ROWS,
      { dimension: "category", grain: "all" },
      "light",
    );
    const series = option.series as Array<{ data: Array<{ value: number }> }>;
    expect(series[0].data[0].value).toBe(12_345);
    expect(series[0].data[1].value).toBe(5_000);
  });

  it("formats tooltip values as dollar strings", () => {
    const option = buildChartOption(
      SAMPLE_ROWS,
      { dimension: "payee", grain: "all" },
      "light",
    );
    const formatter = option.tooltip?.valueFormatter as (value: number) => string;
    expect(formatter(12_345)).toBe("$123.45");
  });

  it.each([
    { dimension: "payee", grain: "all" as const },
    { dimension: "total", grain: "month" as const },
    { dimension: "total", grain: "year" as const },
  ])("formats y-axis labels as dollar strings for $dimension/$grain", ({ dimension, grain }) => {
    const option = buildChartOption(SAMPLE_ROWS, { dimension, grain }, "light");
    const yAxis = option.yAxis as { axisLabel: { formatter: (value: number) => string } };
    expect(yAxis.axisLabel.formatter(12_345)).toBe("$123.45");
  });
});
