/**
 * Shared contract suite for the core `Database` seam: the `batch` and
 * `transaction` semantics every adapter must provide — atomic success,
 * rollback-all on mid-batch failure, correct per-statement `lastInsertId`,
 * and error propagation. Vitest runs it against the better-sqlite3 adapter
 * (`tests/core/db-contract.test.ts`); the Rust backend pins the same
 * semantics in `src-tauri/src/db.rs` tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForeignKeyViolationError, type Database } from "../../src/core";

export interface DatabaseContractHarness {
  db: Database;
  close(): void;
}

export function describeDatabaseContract(
  adapterName: string,
  openDatabase: () => DatabaseContractHarness,
): void {
  describe(`Database contract (${adapterName})`, () => {
    let harness: DatabaseContractHarness;
    let db: Database;

    beforeEach(() => {
      harness = openDatabase();
      db = harness.db;
    });

    afterEach(() => {
      harness.close();
    });

    async function count(table: string): Promise<number> {
      const rows = await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      return rows[0].n;
    }

    describe("batch", () => {
      it("commits all statements atomically with per-statement results", async () => {
        const results = await db.batch([
          { sql: "INSERT INTO payees (name) VALUES (?)", params: ["Water Co"] },
          { sql: "INSERT INTO accounts (name, kind) VALUES (?, ?)", params: ["Checking", "checking"] },
          {
            sql: "INSERT INTO payments (payee_id, account_id, date, amount_cents, source) VALUES (?, ?, ?, ?, ?)",
            params: [1, 1, "2026-01-15", 9999, "manual"],
          },
        ]);

        expect(results).toHaveLength(3);
        expect(results.every((r) => r.rowsAffected === 1)).toBe(true);
        expect(await count("payees")).toBe(1);
        expect(await count("accounts")).toBe(1);
        expect(await count("payments")).toBe(1);
      });

      it("reports the correct lastInsertId per statement", async () => {
        const results = await db.batch([
          { sql: "INSERT INTO payees (name) VALUES (?)", params: ["Water Co"] },
          { sql: "INSERT INTO payees (name) VALUES (?)", params: ["Power Co"] },
          { sql: "INSERT INTO payees (name) VALUES (?)", params: ["Gas Co"] },
        ]);

        const names = ["Water Co", "Power Co", "Gas Co"];
        for (const [index, result] of results.entries()) {
          const rows = await db.select<{ name: string }>(
            "SELECT name FROM payees WHERE id = ?",
            [result.lastInsertId],
          );
          expect(rows).toHaveLength(1);
          expect(rows[0].name).toBe(names[index]);
        }
      });

      it("rolls back every statement on a mid-batch failure and names the failing index", async () => {
        await expect(
          db.batch([
            { sql: "INSERT INTO payees (name) VALUES (?)", params: ["Water Co"] },
            { sql: "INSERT INTO payees (name) VALUES (?)", params: ["Power Co"] },
            {
              // Statement index 2: dangling FK — must fail the whole batch.
              sql: "INSERT INTO payments (payee_id, account_id, date, amount_cents, source) VALUES (?, ?, ?, ?, ?)",
              params: [999, 999, "2026-01-01", 500, "manual"],
            },
            { sql: "INSERT INTO payees (name) VALUES (?)", params: ["Gas Co"] },
          ]),
        ).rejects.toThrow(/batch statement 2 failed/);
        expect(await count("payees")).toBe(0);
        expect(await count("payments")).toBe(0);
      });

      it("maps a FOREIGN KEY failure inside a batch to ForeignKeyViolationError", async () => {
        await expect(
          db.batch([
            {
              sql: "INSERT INTO payments (payee_id, account_id, date, amount_cents, source) VALUES (?, ?, ?, ?, ?)",
              params: [999, 999, "2026-01-01", 500, "manual"],
            },
          ]),
        ).rejects.toBeInstanceOf(ForeignKeyViolationError);
      });

      it("commits an empty statement list as a no-op with no results", async () => {
        await expect(db.batch([])).resolves.toEqual([]);
      });

      // Mirrors cargo test batch_with_hundreds_of_statements_commits_all_rows_in_one_call.
      it("commits hundreds of statements in one atomic batch with ordered lastInsertIds", async () => {
        const STATEMENT_COUNT = 500;
        const results = await db.batch(
          Array.from({ length: STATEMENT_COUNT }, (_, i) => ({
            sql: "INSERT INTO payees (name) VALUES (?)",
            params: [`Payee ${i}`],
          })),
        );

        expect(results).toHaveLength(STATEMENT_COUNT);
        expect(results.every((r) => r.rowsAffected === 1)).toBe(true);
        for (const [i, result] of results.entries()) {
          expect(result.lastInsertId).toBe(results[0].lastInsertId + i);
        }
        expect(await count("payees")).toBe(STATEMENT_COUNT);
      });

      // Mirrors cargo test large_batch_failure_at_statement_k_reports_index_k_and_rolls_back_all.
      it("rolls back a large batch when statement k fails and reports index k", async () => {
        const FAILING_INDEX = 400;
        const statements = Array.from({ length: FAILING_INDEX }, (_, i) => ({
          sql: "INSERT INTO payees (name) VALUES (?)",
          params: [`Payee ${i}`],
        }));
        statements.push({ sql: "INSERT INTO no_such_table (x) VALUES (?)", params: ["1"] });
        statements.push({ sql: "INSERT INTO payees (name) VALUES (?)", params: ["after"] });

        await expect(db.batch(statements)).rejects.toThrow(
          new RegExp(`batch statement ${FAILING_INDEX} failed`),
        );
        expect(await count("payees")).toBe(0);
      });

      // The diagnosed silent-error-swallowing failure mode: rejected promises
      // must carry the canonical SQLite message text, never a generic wrapper.
      it("carries the SQLite message text on rejected batch promises", async () => {
        const fkError = await db
          .batch([
            {
              sql: "INSERT INTO payments (payee_id, account_id, date, amount_cents, source) VALUES (?, ?, ?, ?, ?)",
              params: [999, 999, "2026-01-01", 500, "manual"],
            },
          ])
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(fkError).toBeInstanceOf(Error);
        expect((fkError as Error).message).toContain("FOREIGN KEY constraint failed");

        const missingTableError = await db
          .batch([{ sql: "INSERT INTO no_such_table (x) VALUES (?)", params: [1] }])
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(missingTableError).toBeInstanceOf(Error);
        expect((missingTableError as Error).message).toContain("no such table");
      });

      it("rejects batch calls made inside a transaction (SQLite cannot nest)", async () => {
        await expect(
          db.transaction(async (tx) => {
            await tx.batch([{ sql: "INSERT INTO payees (name) VALUES (?)", params: ["Nested"] }]);
          }),
        ).rejects.toThrow(/transaction within a transaction/);
        expect(await count("payees")).toBe(0);
      });
    });

    describe("transaction", () => {
      it("commits the work and returns its value on success", async () => {
        const value = await db.transaction(async (tx) => {
          const result = await tx.execute("INSERT INTO payees (name) VALUES (?)", ["Water Co"]);
          return result.lastInsertId;
        });

        const rows = await db.select<{ name: string }>("SELECT name FROM payees WHERE id = ?", [
          value,
        ]);
        expect(rows[0].name).toBe("Water Co");
      });

      it("rolls back every write and propagates the error when work throws", async () => {
        await expect(
          db.transaction(async (tx) => {
            await tx.execute("INSERT INTO payees (name) VALUES (?)", ["Water Co"]);
            await tx.execute("INSERT INTO payees (name) VALUES (?)", ["Power Co"]);
            throw new Error("injected transaction failure");
          }),
        ).rejects.toThrow(/injected transaction failure/);

        expect(await count("payees")).toBe(0);
      });

      it("rolls back and propagates a failing statement inside the transaction", async () => {
        await expect(
          db.transaction(async (tx) => {
            await tx.execute("INSERT INTO payees (name) VALUES (?)", ["Water Co"]);
            await tx.execute(
              "INSERT INTO payments (payee_id, account_id, date, amount_cents, source) VALUES (?, ?, ?, ?, ?)",
              [999, 999, "2026-01-01", 500, "manual"],
            );
          }),
        ).rejects.toBeInstanceOf(ForeignKeyViolationError);

        expect(await count("payees")).toBe(0);
      });
    });
  });
}
