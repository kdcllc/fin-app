/**
 * Property-style ledger invariants under a seeded random operation sequence.
 * After EVERY operation: each transaction balances, all splits sum to 0, a
 * rejected operation changed nothing, and for every account the last register
 * running balance equals `balanceAsOf`. The seed is printed on failure.
 * Placeholder accounts only; in-memory database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ForeignKeyViolationError,
  UnbalancedTransactionError,
  ValidationError,
  balanceAsOf,
  createIncome,
  createTransfer,
  deleteTransaction,
  getRegister,
  postTransaction,
  setOpeningBalance,
  updateTransaction,
  type LedgerAccount,
  type LedgerRepo,
  type NewSplit,
} from "../../src/core";
import { openTestDb, type TestDb } from "../support/test-db";

/** mulberry32: small deterministic PRNG, no dependency. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)],
  };
}

const SEEDS = [20240611, 987654321];
const OPS_PER_SEED = 250;
// CI runners are ~3x slower than local; 250 ops take ~5 s there, over the 5 s default.
const SEED_TEST_TIMEOUT_MS = 30_000;
const FAR_FUTURE = "9999-12-31";

let t: TestDb;
let ledger: LedgerRepo;
let postable: LedgerAccount[]; // non-placeholder, non-opening-balances
let funding: LedgerAccount[];
let incomeAccounts: LedgerAccount[];
let openable: LedgerAccount[];
let placeholderId: number;
let payeeIds: number[];

beforeEach(async () => {
  t = openTestDb();
  ledger = t.repos.ledger;
  const root = async (role: "root_asset" | "root_liability" | "root_income" | "root_expense") =>
    (await ledger.getSystemAccount(role)) as LedgerAccount;
  const [ra, rl, ri, re] = [
    await root("root_asset"),
    await root("root_liability"),
    await root("root_income"),
    await root("root_expense"),
  ];

  const group = await ledger.insertAccount({
    name: "Bank Group",
    type: "ASSET",
    parent_id: ra.id,
    placeholder: true,
  });
  placeholderId = group.id;
  await ledger.insertAccount({
    name: "Checking A",
    type: "ASSET",
    subtype: "bank",
    parent_id: group.id,
  });
  await ledger.insertAccount({
    name: "Savings A",
    type: "ASSET",
    subtype: "savings",
    parent_id: ra.id,
  });
  await ledger.insertAccount({ name: "Cash A", type: "ASSET", subtype: "cash", parent_id: ra.id });
  await ledger.insertAccount({
    name: "Card A",
    type: "LIABILITY",
    subtype: "credit_card",
    parent_id: rl.id,
  });
  await ledger.insertAccount({ name: "Salary", type: "INCOME", parent_id: ri.id });
  await ledger.insertAccount({ name: "Interest", type: "INCOME", parent_id: ri.id });
  const food = await ledger.insertAccount({ name: "Food", type: "EXPENSE", parent_id: re.id });
  await ledger.insertAccount({ name: "Dining", type: "EXPENSE", parent_id: food.id });
  await ledger.insertAccount({ name: "Rent", type: "EXPENSE", parent_id: re.id });

  payeeIds = [
    (await t.db.execute("INSERT INTO payees (name) VALUES ('Payee One')")).lastInsertId,
    (await t.db.execute("INSERT INTO payees (name) VALUES ('Payee Two')")).lastInsertId,
  ];

  const all = await ledger.listAccounts();
  postable = all.filter((a) => !a.placeholder && a.system_role !== "opening_balances");
  funding = postable.filter((a) => a.type === "ASSET" || a.type === "LIABILITY");
  incomeAccounts = postable.filter((a) => a.type === "INCOME");
  openable = postable.filter((a) => a.system_role === null && a.type !== "EQUITY");
});
afterEach(() => t.close());

async function snapshot(): Promise<string> {
  const tx = await t.db.select("SELECT * FROM transactions ORDER BY id");
  const sp = await t.db.select("SELECT * FROM splits ORDER BY id");
  return JSON.stringify({ tx, sp });
}

async function assertInvariants(): Promise<void> {
  const unbalanced = await t.db.select<{ transaction_id: number; s: number }>(
    "SELECT transaction_id, SUM(amount_cents) AS s FROM splits GROUP BY transaction_id HAVING s != 0",
  );
  expect(unbalanced, "unbalanced transactions").toEqual([]);
  const thin = await t.db.select(
    "SELECT transaction_id FROM splits GROUP BY transaction_id HAVING COUNT(*) < 2",
  );
  expect(thin, "transactions with < 2 splits").toEqual([]);
  const orphans = await t.db.select(
    "SELECT id FROM splits WHERE transaction_id NOT IN (SELECT id FROM transactions)",
  );
  expect(orphans, "orphan splits").toEqual([]);
  const [total] = await t.db.select<{ s: number }>(
    "SELECT COALESCE(SUM(amount_cents), 0) AS s FROM splits",
  );
  expect(total.s, "grand total of all splits").toBe(0);

  for (const account of await ledger.listAccounts()) {
    const register = await getRegister(ledger, account.id);
    const last = register.length === 0 ? 0 : register[register.length - 1].running_balance_cents;
    const balance = await balanceAsOf(ledger, account.id, FAR_FUTURE);
    expect(last, `register vs balanceAsOf for "${account.name}"`).toBe(balance);
    const [raw] = await t.db.select<{ s: number }>(
      "SELECT COALESCE(SUM(amount_cents), 0) AS s FROM splits WHERE account_id = ?",
      [account.id],
    );
    expect(balance, `balanceAsOf vs raw SQL for "${account.name}"`).toBe(raw.s);
  }
}

describe("PRNG", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const run = (seed: number) => {
      const r = makeRng(seed);
      return Array.from({ length: 5 }, () => r.int(0, 1_000_000));
    };
    expect(run(1)).toEqual(run(1));
    expect(run(1)).not.toEqual(run(2));
  });
});

describe("ledger invariants under random operations", () => {
  for (const seed of SEEDS) {
    it(
      `holds after each of ${OPS_PER_SEED} operations (seed ${seed})`,
      async () => {
        const rng = makeRng(seed);
        const date = () =>
          `2024-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`;
        const cents = () => rng.int(1, 250_000);
        const maybePayee = () => (rng.next() < 0.5 ? rng.pick(payeeIds) : null);
        const randomSplits = (): NewSplit[] => {
          const n = rng.int(2, 4);
          const splits: NewSplit[] = [];
          let sum = 0;
          for (let i = 0; i < n - 1; i++) {
            const amount = rng.int(-100_000, 100_000);
            sum += amount;
            splits.push({ account_id: rng.pick(postable).id, amount_cents: amount });
          }
          splits.push({ account_id: rng.pick(postable).id, amount_cents: -sum });
          return splits;
        };
        const existingIds = async () =>
          (await t.db.select<{ id: number }>("SELECT id FROM transactions ORDER BY id")).map(
            (r) => r.id,
          );

        const counts: Record<string, number> = {};
        const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
        let i = 0;
        let desc = "";

        try {
          for (; i < OPS_PER_SEED; i++) {
            const roll = rng.int(0, 99);
            const ids = await existingIds();
            const before = await snapshot();
            let rejected: (new (...args: never[]) => Error) | null = null;
            let attempt: () => Promise<unknown>;

            if (roll < 22) {
              desc = "post";
              attempt = () =>
                postTransaction(ledger, {
                  date: date(),
                  payee_id: maybePayee(),
                  splits: randomSplits(),
                });
            } else if (roll < 36 && ids.length > 0) {
              desc = "update";
              const id = rng.pick(ids);
              attempt = () =>
                updateTransaction(ledger, id, {
                  date: date(),
                  payee_id: maybePayee(),
                  splits: randomSplits(),
                });
            } else if (roll < 46 && ids.length > 0) {
              desc = "delete";
              const id = rng.pick(ids);
              attempt = () => deleteTransaction(ledger, id);
            } else if (roll < 58) {
              desc = "transfer";
              const from = rng.pick(funding);
              const to = rng.pick(funding.filter((a) => a.id !== from.id));
              attempt = () =>
                createTransfer(ledger, {
                  date: date(),
                  fromAccountId: from.id,
                  toAccountId: to.id,
                  amount_cents: cents(),
                });
            } else if (roll < 70) {
              desc = "income";
              attempt = () =>
                createIncome(ledger, {
                  date: date(),
                  incomeAccountId: rng.pick(incomeAccounts).id,
                  depositAccountId: rng.pick(funding).id,
                  amount_cents: cents(),
                  payee_id: maybePayee(),
                });
            } else if (roll < 80) {
              desc = "opening balance";
              const account = rng.pick(openable);
              const amount = rng.next() < 0.2 ? 0 : rng.int(-50_000, 500_000);
              attempt = () => setOpeningBalance(ledger, account.id, "2024-01-01", amount);
            } else if (roll < 87) {
              desc = "unbalanced post (rejected)";
              rejected = UnbalancedTransactionError;
              const splits = randomSplits();
              splits[0] = { ...splits[0], amount_cents: splits[0].amount_cents + rng.int(1, 5000) };
              attempt = () => postTransaction(ledger, { date: date(), splits });
            } else if (roll < 92 && ids.length > 0) {
              desc = "unbalanced update (rejected)";
              rejected = UnbalancedTransactionError;
              const id = rng.pick(ids);
              const splits = randomSplits();
              splits[1] = { ...splits[1], amount_cents: splits[1].amount_cents - rng.int(1, 5000) };
              attempt = () => updateTransaction(ledger, id, { date: date(), splits });
            } else if (roll < 95) {
              desc = "post to placeholder (rejected)";
              rejected = ValidationError;
              const amount = cents();
              attempt = () =>
                postTransaction(ledger, {
                  date: date(),
                  splits: [
                    { account_id: placeholderId, amount_cents: amount },
                    { account_id: rng.pick(postable).id, amount_cents: -amount },
                  ],
                });
            } else if (roll < 98) {
              desc = "post to unknown account (rejected)";
              rejected = ForeignKeyViolationError;
              const amount = cents();
              attempt = () =>
                postTransaction(ledger, {
                  date: date(),
                  splits: [
                    { account_id: 9_999_999, amount_cents: amount },
                    { account_id: rng.pick(postable).id, amount_cents: -amount },
                  ],
                });
            } else {
              desc = "transfer to self (rejected)";
              rejected = ValidationError;
              const acct = rng.pick(funding);
              attempt = () =>
                createTransfer(ledger, {
                  date: date(),
                  fromAccountId: acct.id,
                  toAccountId: acct.id,
                  amount_cents: cents(),
                });
            }

            if (rejected !== null) {
              await expect(attempt(), desc).rejects.toBeInstanceOf(rejected);
              expect(await snapshot(), `${desc} must change nothing`).toBe(before);
            } else {
              await attempt();
            }
            bump(desc);
            await assertInvariants();
          }

          // The run must have exercised every operation kind, including rejections.
          expect(i).toBeGreaterThanOrEqual(200);
          for (const kind of [
            "post",
            "update",
            "delete",
            "transfer",
            "income",
            "opening balance",
            "unbalanced post (rejected)",
          ]) {
            expect(counts[kind] ?? 0, `kind "${kind}" never ran`).toBeGreaterThan(0);
          }
          expect((await existingIds()).length).toBeGreaterThan(0);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `ledger invariant failure [seed=${seed} op=${i} kind="${desc}"]: ${message}`,
            { cause: error },
          );
        }
      },
      SEED_TEST_TIMEOUT_MS,
    );
  }
});
