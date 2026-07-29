import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type TestDb } from "../support/test-db";

describe("import log repository", () => {
  let t: TestDb;
  beforeEach(() => (t = openTestDb()));
  afterEach(() => t.close());

  it("round-trips append and list, oldest first", async () => {
    const first = await t.repos.importLog.append({
      source_file: "2026-bill-pay.xlsx",
      content_hash: "abc123",
      row_count: 42,
    });
    const second = await t.repos.importLog.append({
      source_file: "2025-bill-pay.xlsx",
      content_hash: "def456",
      row_count: 17,
    });

    expect(first).toEqual({
      id: first.id,
      source_file: "2026-bill-pay.xlsx",
      content_hash: "abc123",
      imported_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      row_count: 42,
    });
    expect(await t.repos.importLog.list()).toEqual([first, second]);
  });

  it("looks up the latest entry by content hash", async () => {
    await t.repos.importLog.append({
      source_file: "2026-bill-pay.xlsx",
      content_hash: "hash-same",
      row_count: 40,
    });
    const latest = await t.repos.importLog.append({
      source_file: "2026-bill-pay-v2.xlsx",
      content_hash: "hash-same",
      row_count: 41,
    });

    expect(await t.repos.importLog.findLatestByContentHash("hash-same")).toEqual(latest);
    expect(await t.repos.importLog.findLatestByContentHash("missing-hash")).toBeNull();
  });
});
