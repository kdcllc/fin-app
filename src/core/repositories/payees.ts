import type { Database } from "../db";
import type { NewPayee, Payee, PayeePatch } from "../entities";
import { EntityInUseError, PayeeMergeError, ValidationError } from "../errors";
import { buildUpdate } from "./helpers";

interface PayeeRow {
  id: number;
  name: string;
  default_category_id: number | null;
  default_account_id: number | null;
  notes: string | null;
  archived: 0 | 1;
}

const COLUMNS = "id, name, default_category_id, default_account_id, notes, archived";

function toPayee(row: PayeeRow): Payee {
  return { ...row, archived: row.archived === 1 };
}

export interface PayeesRepo {
  /** Active payees by default; pass `includeArchived` for the full set. */
  list(options?: { includeArchived?: boolean }): Promise<Payee[]>;
  /** Fetch by id — returns archived payees too (history stays reachable). */
  get(id: number): Promise<Payee | null>;
  insert(payee: NewPayee): Promise<Payee>;
  /** Apply a partial patch; returns the updated row, or null if `id` is unknown. */
  update(id: number, patch: PayeePatch): Promise<Payee | null>;
  /** Soft-delete: hides from default lists, keeps payment history intact. */
  archive(id: number): Promise<boolean>;
  /** Hard delete only when not referenced by any rows. */
  delete(id: number): Promise<boolean>;
  /**
   * Reassign all payments from source payee to survivor payee, then archive
   * the source payee.
   */
  merge(survivorId: number, sourceId: number): Promise<{ reassignedPayments: number }>;
}

export function createPayeesRepo(db: Database): PayeesRepo {
  async function get(id: number): Promise<Payee | null> {
    const rows = await db.select<PayeeRow>(`SELECT ${COLUMNS} FROM payees WHERE id = ?`, [id]);
    return rows.length > 0 ? toPayee(rows[0]) : null;
  }

  async function getFrom(database: Database, id: number): Promise<Payee | null> {
    const rows = await database.select<PayeeRow>(`SELECT ${COLUMNS} FROM payees WHERE id = ?`, [id]);
    return rows.length > 0 ? toPayee(rows[0]) : null;
  }

  function assertValidNewPayee(payee: NewPayee): void {
    if (payee.name.trim().length === 0) {
      throw new ValidationError("Payee name is required.");
    }
  }

  function assertValidPayeePatch(patch: PayeePatch): void {
    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw new ValidationError("Payee name is required.");
    }
  }

  async function count(sql: string, params: Array<string | number | null>): Promise<number> {
    const rows = await db.select<{ count: number }>(sql, params);
    return rows[0]?.count ?? 0;
  }

  return {
    async list({ includeArchived = false } = {}) {
      const where = includeArchived ? "" : " WHERE archived = 0";
      const rows = await db.select<PayeeRow>(
        `SELECT ${COLUMNS} FROM payees${where} ORDER BY name, id`,
      );
      return rows.map(toPayee);
    },

    get,

    async insert(payee) {
      assertValidNewPayee(payee);
      const result = await db.execute(
        "INSERT INTO payees (name, default_category_id, default_account_id, notes) VALUES (?, ?, ?, ?)",
        [
          payee.name,
          payee.default_category_id ?? null,
          payee.default_account_id ?? null,
          payee.notes ?? null,
        ],
      );
      const created = await get(result.lastInsertId);
      if (!created) throw new Error(`payees.insert: row ${result.lastInsertId} missing`);
      return created;
    },

    async update(id, patch) {
      assertValidPayeePatch(patch);
      const statement = buildUpdate(
        "payees",
        {
          name: patch.name,
          default_category_id: patch.default_category_id,
          default_account_id: patch.default_account_id,
          notes: patch.notes,
        },
        id,
      );
      if (statement) await db.execute(statement.sql, statement.params);
      return get(id);
    },

    async archive(id) {
      const result = await db.execute("UPDATE payees SET archived = 1 WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },

    async delete(id) {
      const existing = await get(id);
      if (!existing) return false;

      const paymentRefs = await count("SELECT COUNT(*) AS count FROM payments WHERE payee_id = ?", [id]);
      if (paymentRefs > 0) {
        throw new EntityInUseError(
          "Cannot delete this payee because payment history references it. Archive the payee instead.",
        );
      }

      const recurringRefs = await count(
        "SELECT COUNT(*) AS count FROM recurring_bills WHERE payee_id = ?",
        [id],
      );
      if (recurringRefs > 0) {
        throw new EntityInUseError(
          "Cannot delete this payee because recurring bills still reference it.",
        );
      }

      const result = await db.execute("DELETE FROM payees WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },

    async merge(survivorId, sourceId) {
      if (survivorId === sourceId) {
        throw new PayeeMergeError("Cannot merge a payee into itself.");
      }

      return db.transaction(async (txDb) => {
        const survivor = await getFrom(txDb, survivorId);
        if (!survivor) {
          throw new PayeeMergeError("Cannot merge payees: survivor payee was not found.");
        }
        if (survivor.archived) {
          throw new PayeeMergeError("Cannot merge into an archived payee.");
        }

        const source = await getFrom(txDb, sourceId);
        if (!source) {
          throw new PayeeMergeError("Cannot merge payees: source payee was not found.");
        }
        if (source.archived) {
          throw new PayeeMergeError("Cannot merge an already archived payee.");
        }

        const reassigned = await txDb.execute(
          "UPDATE payments SET payee_id = ? WHERE payee_id = ?",
          [survivorId, sourceId],
        );

        await txDb.execute("UPDATE recurring_bills SET payee_id = ? WHERE payee_id = ?", [
          survivorId,
          sourceId,
        ]);

        await txDb.execute("UPDATE payees SET archived = 1 WHERE id = ?", [sourceId]);

        return { reassignedPayments: reassigned.rowsAffected };
      });
    },
  };
}
