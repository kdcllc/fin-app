import type { EChartsOption } from "echarts";
import { formatCentsDecimal, type ReportGrain, type ReportRow } from "../core";

export type ChartTheme = "light" | "dark";

const THEME_TOKENS: Record<
  ChartTheme,
  { background: string; text: string; muted: string; axis: string; splitLine: string }
> = {
  light: {
    background: "#f6f6f6",
    text: "#0f0f0f",
    muted: "#5f6368",
    axis: "#d7d7d7",
    splitLine: "#ececec",
  },
  dark: {
    background: "#2f2f2f",
    text: "#f6f6f6",
    muted: "#a8adb4",
    axis: "#454545",
    splitLine: "#3a3a3a",
  },
};

export function formatReportDollars(amountCents: number): string {
  const formatted = formatCentsDecimal(amountCents);
  if (formatted.startsWith("-")) {
    return `-$${formatted.slice(1)}`;
  }
  return `$${formatted}`;
}

export interface ChartSpec {
  dimension: "category" | "payee" | "account" | "total";
  grain: ReportGrain;
}

function baseOption(theme: ChartTheme): EChartsOption {
  const tokens = THEME_TOKENS[theme];
  return {
    backgroundColor: tokens.background,
    textStyle: { color: tokens.text },
    tooltip: {
      trigger: "item",
      valueFormatter: (value) => formatReportDollars(Number(value)),
    },
  };
}

function axisStyle(theme: ChartTheme) {
  const tokens = THEME_TOKENS[theme];
  return {
    axisLine: { lineStyle: { color: tokens.axis } },
    axisLabel: { color: tokens.muted },
    splitLine: { lineStyle: { color: tokens.splitLine } },
  };
}

export function buildChartOption(
  rows: ReportRow[],
  spec: ChartSpec,
  theme: ChartTheme,
): EChartsOption {
  const tokens = THEME_TOKENS[theme];
  const option = baseOption(theme);

  if (spec.dimension === "category" && spec.grain === "all") {
    return {
      ...option,
      tooltip: { ...option.tooltip, trigger: "item" },
      series: [
        {
          type: "pie",
          radius: "65%",
          data: rows.map((row) => ({
            name: row.groupLabel,
            value: row.total_cents,
          })),
          label: { color: tokens.text },
        },
      ],
    };
  }

  if (spec.dimension === "payee" && spec.grain === "all") {
    return {
      ...option,
      tooltip: { ...option.tooltip, trigger: "axis" },
      grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
      xAxis: {
        type: "category",
        data: rows.map((row) => row.groupLabel),
        ...axisStyle(theme),
      },
      yAxis: {
        type: "value",
        ...axisStyle(theme),
        axisLabel: {
          color: tokens.muted,
          formatter: (value: number) => formatReportDollars(value),
        },
      },
      series: [
        {
          type: "bar",
          data: rows.map((row) => row.total_cents),
        },
      ],
    };
  }

  if (spec.dimension === "account" && spec.grain === "all") {
    return {
      ...option,
      tooltip: { ...option.tooltip, trigger: "item" },
      series: [
        {
          type: "pie",
          radius: "65%",
          data: rows.map((row) => ({
            name: row.groupLabel,
            value: row.total_cents,
          })),
          label: { color: tokens.text },
        },
      ],
    };
  }

  if (spec.dimension === "total" && spec.grain === "month") {
    return {
      ...option,
      tooltip: { ...option.tooltip, trigger: "axis" },
      grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
      xAxis: {
        type: "category",
        data: rows.map((row) => row.periodKey),
        ...axisStyle(theme),
      },
      yAxis: {
        type: "value",
        ...axisStyle(theme),
        axisLabel: {
          color: tokens.muted,
          formatter: (value: number) => formatReportDollars(value),
        },
      },
      series: [
        {
          type: "line",
          areaStyle: {},
          data: rows.map((row) => row.total_cents),
        },
      ],
    };
  }

  if (spec.dimension === "total" && spec.grain === "year") {
    return {
      ...option,
      tooltip: { ...option.tooltip, trigger: "axis" },
      grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
      xAxis: {
        type: "category",
        data: rows.map((row) => row.periodKey),
        ...axisStyle(theme),
      },
      yAxis: {
        type: "value",
        ...axisStyle(theme),
        axisLabel: {
          color: tokens.muted,
          formatter: (value: number) => formatReportDollars(value),
        },
      },
      series: [
        {
          type: "bar",
          data: rows.map((row) => row.total_cents),
        },
      ],
    };
  }

  return option;
}

export function chartThemeTokens(theme: ChartTheme) {
  return THEME_TOKENS[theme];
}
