/**
 * Report parity: the same data reported over the legacy v8 `payments` /
 * `categories` tables (inline SQL, computed BEFORE migration) and over the
 * migrated ledger via `runReportQuery` (AFTER migration) must agree on labels,
 * totals, counts and keys (category keys through `legacy_category_map`).
 * Data: tests/fixtures/report/reporting-fixture.json plus a few extra rows
 * (placeholders only), seeded with raw SQL at v8.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixture from "../fixtures/report/reporting-fixture.json";
import { ValidationError, runReportQuery } from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

interface Window {
  from: string;
  to: string;
  accountId?: number;
  categoryId?: number | null; // LEGACY category id (null = uncategorized)
}
interface Expected {
  groupKey: number | null;
  groupLabel: string;
  periodKey: string;
  total_cents: number;
  count: number;
}

let t: TestDb;
let categoryMap: Map<number, number>;
const accountIds = new Map<string, number>();
const categoryIds = new Map<string, number>();

// Extra rows widen coverage: a nested category, a refund, a zero amount, a same-month second payee.
const EXTRA_PAYMENTS = [
  {
    date: "2026-01-25",
    payee: "Water Co",
    account: "Visa",
    category: "Groceries",
    amount_cents: -1500,
  },
  {
    date: "2026-03-02",
    payee: "Power Co",
    account: "Checking",
    category: "Electric",
    amount_cents: 0,
  },
  {
    date: "2026-03-28",
    payee: "Power Co",
    account: "Visa",
    category: "Electric",
    amount_cents: 8800,
  },
  { date: "2027-01-05", payee: "Water Co", account: "Checking", category: null, amount_cents: 450 },
];

function filterSql(w: Window): { where: string; params: (string | number)[] } {
  const clauses = ["p.date >= ?", "p.date <= ?"];
  const params: (string | number)[] = [w.from, w.to];
  if (w.accountId !== undefined) {
    clauses.push("p.account_id = ?");
    params.push(w.accountId);
  }
  if (w.categoryId === null) clauses.push("p.category_id IS NULL");
  else if (w.categoryId !== undefined) {
    clauses.push("p.category_id = ?");
    params.push(w.categoryId);
  }
  return { where: clauses.join(" AND "), params };
}

function months(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

type Key = "category" | "payee" | "account";
/** Legacy expected rows, computed with SQL over the v8 tables. */
async function legacyRows(
  db: TestDb["db"],
  dim: Key | "month" | "year",
  w: Window,
): Promise<Expected[]> {
  const { where, params } = filterSql(w);
  const grouped = async (keyExpr: string, labelExpr: string, join: string) =>
    (
      await db.select<{ k: number | null; label: string; total: number; n: number }>(
        `SELECT ${keyExpr} AS k, ${labelExpr} AS label, SUM(p.amount_cents) AS total, COUNT(*) AS n
         FROM payments p ${join} WHERE ${where} GROUP BY ${keyExpr}`,
        params,
      )
    ).map((r) => ({
      groupKey: r.k,
      groupLabel: r.label,
      periodKey: "",
      total_cents: r.total,
      count: r.n,
    }));

  if (dim === "category") {
    return grouped(
      "p.category_id",
      "COALESCE(c.name, 'Uncategorized')",
      "LEFT JOIN categories c ON c.id = p.category_id",
    );
  }
  if (dim === "payee")
    return grouped("p.payee_id", "py.name", "JOIN payees py ON py.id = p.payee_id");
  if (dim === "account")
    return grouped("p.account_id", "a.name", "JOIN accounts a ON a.id = p.account_id");

  const len = dim === "month" ? 7 : 4;
  const rows = await db.select<{ period: string; total: number; n: number }>(
    `SELECT substr(p.date, 1, ${len}) AS period, SUM(p.amount_cents) AS total, COUNT(*) AS n
     FROM payments p WHERE ${where} GROUP BY period ORDER BY period`,
    params,
  );
  const byPeriod = new Map(rows.map((r) => [r.period, r]));
  const periods = dim === "month" ? months(w.from, w.to) : rows.map((r) => r.period);
  return periods.map((periodKey) => ({
    groupKey: null,
    groupLabel: "",
    periodKey,
    total_cents: byPeriod.get(periodKey)?.total ?? 0,
    count: byPeriod.get(periodKey)?.n ?? 0,
  }));
}

const canon = (rows: Expected[]) =>
  [...rows].sort(
    (a, b) =>
      a.periodKey.localeCompare(b.periodKey) ||
      a.groupLabel.localeCompare(b.groupLabel) ||
      (a.groupKey ?? Number.MAX_SAFE_INTEGER) - (b.groupKey ?? Number.MAX_SAFE_INTEGER),
  );

const WINDOWS: Record<string, Window> = {
  "fixture window": { from: fixture.window.from, to: fixture.window.to },
  everything: { from: "2020-01-01", to: "2027-12-31" },
  "leap-day month": { from: "2024-02-01", to: "2024-02-29" },
  "one account": { from: "2020-01-01", to: "2027-12-31" }, // accountId filled in beforeAll
  "uncategorized only": { from: "2020-01-01", to: "2027-12-31", categoryId: null },
  "one category": { from: "2020-01-01", to: "2027-12-31" }, // categoryId filled in beforeAll
};

const before = new Map<string, Expected[]>();

beforeAll(async () => {
  t = openTestDb({ upToVersion: 8 });
  const { db } = t;

  for (const a of fixture.accounts) {
    const r = await db.execute("INSERT INTO accounts (name, kind) VALUES (?, ?)", [a.name, a.kind]);
    accountIds.set(a.name, r.lastInsertId);
  }
  const payeeIds = new Map<string, number>();
  for (const p of fixture.payees) {
    payeeIds.set(
      p.name,
      (await db.execute("INSERT INTO payees (name) VALUES (?)", [p.name])).lastInsertId,
    );
  }
  for (const c of fixture.categories) {
    categoryIds.set(
      c.name,
      (await db.execute("INSERT INTO categories (name) VALUES (?)", [c.name])).lastInsertId,
    );
  }
  // Nested category: Electric under Utilities.
  categoryIds.set(
    "Electric",
    (
      await db.execute("INSERT INTO categories (name, parent_id) VALUES ('Electric', ?)", [
        categoryIds.get("Utilities") as number,
      ])
    ).lastInsertId,
  );

  for (const p of [...fixture.payments, ...EXTRA_PAYMENTS]) {
    await db.execute(
      "INSERT INTO payments (payee_id, account_id, category_id, date, amount_cents, source) VALUES (?, ?, ?, ?, ?, 'manual')",
      [
        payeeIds.get(p.payee) as number,
        accountIds.get(p.account) as number,
        p.category === null ? null : (categoryIds.get(p.category) as number),
        p.date,
        p.amount_cents,
      ],
    );
  }

  WINDOWS["one account"].accountId = accountIds.get("Checking") as number;
  WINDOWS["one category"].categoryId = categoryIds.get("Groceries") as number;

  for (const [name, w] of Object.entries(WINDOWS)) {
    for (const dim of ["category", "payee", "account", "month", "year"] as const) {
      before.set(`${name}|${dim}`, await legacyRows(db, dim, w));
    }
  }

  t.applyRemainingMigrations();
  categoryMap = new Map(
    (
      await db.select<{ category_id: number; account_id: number }>(
        "SELECT category_id, account_id FROM legacy_category_map",
      )
    ).map((r) => [r.category_id, r.account_id]),
  );
});

afterAll(() => t.close());

function toNew(w: Window) {
  return {
    from: w.from,
    to: w.to,
    ...(w.accountId !== undefined ? { accountId: w.accountId } : {}),
    ...(w.categoryId === null
      ? { categoryId: null }
      : w.categoryId !== undefined
        ? { categoryId: categoryMap.get(w.categoryId) as number }
        : {}),
  };
}

describe("report parity before/after migration 0009", () => {
  it("sanity: the seeded data produces non-trivial legacy aggregates", () => {
    const cat = before.get("everything|category") as Expected[];
    expect(cat.length).toBe(4); // Utilities, Groceries, Electric, Uncategorized
    expect(cat.some((r) => r.groupKey === null && r.groupLabel === "Uncategorized")).toBe(true);
    expect(before.get("everything|month")?.some((r) => r.total_cents < 0 || r.count === 0)).toBe(
      true,
    );
    expect(before.get("everything|year")?.map((r) => r.periodKey)).toEqual([
      "2024",
      "2025",
      "2026",
      "2027",
    ]);
  });

  for (const [windowName, w] of Object.entries(WINDOWS)) {
    describe(windowName, () => {
      for (const dim of ["category", "payee", "account"] as const) {
        it(`${dim} / all`, async () => {
          const expected = before.get(`${windowName}|${dim}`) as Expected[];
          const actual = await runReportQuery(t.repos, {
            dimension: dim,
            grain: "all",
            filter: toNew(w),
          });
          const mapped = expected.map((r) => ({
            ...r,
            groupKey:
              dim === "category" && r.groupKey !== null
                ? (categoryMap.get(r.groupKey) as number)
                : r.groupKey,
          }));
          expect(canon(actual)).toEqual(canon(mapped));
          // Product ordering contract: total descending.
          const totals = actual.map((r) => r.total_cents);
          expect(totals).toEqual([...totals].sort((a, b) => b - a));
        });
      }
      it("total / month", async () => {
        const actual = await runReportQuery(t.repos, {
          dimension: "total",
          grain: "month",
          filter: toNew(w),
        });
        expect(actual).toEqual(before.get(`${windowName}|month`));
      });
      it("total / year", async () => {
        const actual = await runReportQuery(t.repos, {
          dimension: "total",
          grain: "year",
          filter: toNew(w),
        });
        expect(actual).toEqual(before.get(`${windowName}|year`));
      });
    });
  }

  it("matches a literal fixture total (December 2025 Power Co payment)", async () => {
    const rows = await runReportQuery(t.repos, {
      dimension: "payee",
      grain: "all",
      filter: { from: "2025-12-01", to: "2025-12-31" },
    });
    expect(rows.map((r) => [r.groupLabel, r.total_cents, r.count])).toEqual([
      ["Power Co", 5000, 1],
    ]);
  });

  it("still rejects unsupported dimension/grain combinations", async () => {
    await expect(
      runReportQuery(t.repos, {
        dimension: "total",
        grain: "all",
        filter: { from: "2024-01-01", to: "2024-12-31" },
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      runReportQuery(t.repos, {
        dimension: "category",
        grain: "month",
        filter: { from: "2024-01-01", to: "2024-12-31" },
      }),
    ).rejects.toThrow(ValidationError);
  });
});
