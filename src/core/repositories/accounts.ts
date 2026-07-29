import type { Database } from "../db";
import type { Account, AccountKind, AccountPatch, NewAccount } from "../entities";
import { EntityInUseError, ValidationError } from "../errors";
import { resolveInsertedRow } from "./insert-verify";
import { buildUpdate } from "./helpers";

interface AccountRow {
  id: number;
  name: string;
  kind: AccountKind;
  last4: string | null;
  gnucash_guid: string | null;
  archived: 0 | 1;
}

const COLUMNS = "id, name, kind, last4, gnucash_guid, archived";

function toAccount(row: AccountRow): Account {
  return { ...row, archived: row.archived === 1 };
}

export interface AccountsRepo {
  /** Active accounts by default; pass `includeArchived` for the full set. */
  list(options?: { includeArchived?: boolean }): Promise<Account[]>;
  /** Fetch by id — returns archived accounts too (history stays reachable). */
  get(id: number): Promise<Account | null>;
  insert(account: NewAccount): Promise<Account>;
  /** Apply a partial patch; returns the updated row, or null if `id` is unknown. */
  update(id: number, patch: AccountPatch): Promise<Account | null>;
  /** Soft-delete: hides from default lists, keeps payment history intact. */
  archive(id: number): Promise<boolean>;
  /** Hard delete only when not referenced by any rows. */
  delete(id: number): Promise<boolean>;
}

export function createAccountsRepo(db: Database): AccountsRepo {
  async function get(id: number): Promise<Account | null> {
    const rows = await db.select<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`, [id]);
    return rows.length > 0 ? toAccount(rows[0]) : null;
  }

  function assertValidNewAccount(account: NewAccount): void {
    if (account.name.trim().length === 0) {
      throw new ValidationError("Account name is required.");
    }
    if (account.last4 !== undefined && account.last4 !== null && !/^\d{4}$/.test(account.last4)) {
      throw new ValidationError("Account last4 must be exactly four digits when provided.");
    }
  }

  function assertValidAccountPatch(patch: AccountPatch): void {
    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw new ValidationError("Account name is required.");
    }
    if (patch.last4 !== undefined && patch.last4 !== null && !/^\d{4}$/.test(patch.last4)) {
      throw new ValidationError("Account last4 must be exactly four digits when provided.");
    }
  }

  async function count(sql: string, params: Array<string | number | null>): Promise<number> {
    const rows = await db.select<{ count: number }>(sql, params);
    return rows[0]?.count ?? 0;
  }

  function matchesPayload(row: Account, account: NewAccount): boolean {
    return (
      row.name === account.name &&
      row.kind === account.kind &&
      row.last4 === (account.last4 ?? null) &&
      row.gnucash_guid === (account.gnucash_guid ?? null)
    );
  }

  async function findByPayload(account: NewAccount): Promise<Account[]> {
    const rows = await db.select<AccountRow>(
      `SELECT ${COLUMNS}
       FROM accounts
       WHERE name = ?
         AND kind = ?
         AND last4 IS ?
         AND gnucash_guid IS ?
       ORDER BY id DESC
       LIMIT 2`,
      [
        account.name,
        account.kind,
        account.last4 ?? null,
        account.gnucash_guid ?? null,
      ],
    );
    return rows.map(toAccount);
  }

  return {
    async list({ includeArchived = false } = {}) {
      const where = includeArchived ? "" : " WHERE archived = 0";
      const rows = await db.select<AccountRow>(
        `SELECT ${COLUMNS} FROM accounts${where} ORDER BY name, id`,
      );
      return rows.map(toAccount);
    },

    get,

    async insert(account) {
      assertValidNewAccount(account);
      const result = await db.execute(
        "INSERT INTO accounts (name, kind, last4, gnucash_guid) VALUES (?, ?, ?, ?)",
        [account.name, account.kind, account.last4 ?? null, account.gnucash_guid ?? null],
      );
      return resolveInsertedRow({
        context: "accounts.insert",
        lastInsertId: result.lastInsertId,
        payload: account,
        getById: get,
        payloadMatches: matchesPayload,
        findByPayload,
      });
    },

    async update(id, patch) {
      assertValidAccountPatch(patch);
      const statement = buildUpdate(
        "accounts",
        {
          name: patch.name,
          kind: patch.kind,
          last4: patch.last4,
          gnucash_guid: patch.gnucash_guid,
        },
        id,
      );
      if (statement) await db.execute(statement.sql, statement.params);
      return get(id);
    },

    async archive(id) {
      const result = await db.execute("UPDATE accounts SET archived = 1 WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },

    async delete(id) {
      const existing = await get(id);
      if (!existing) return false;

      const paymentRefs = await count("SELECT COUNT(*) AS count FROM payments WHERE account_id = ?", [id]);
      if (paymentRefs > 0) {
        throw new EntityInUseError(
          "Cannot delete this account because payment history references it. Archive the account instead.",
        );
      }

      const payeeDefaultRefs = await count(
        "SELECT COUNT(*) AS count FROM payees WHERE default_account_id = ?",
        [id],
      );
      if (payeeDefaultRefs > 0) {
        throw new EntityInUseError(
          "Cannot delete this account because payee defaults still reference it.",
        );
      }

      const result = await db.execute("DELETE FROM accounts WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },
  };
}
