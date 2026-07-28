import type { Database } from "../db";
import type { Account, AccountKind, AccountPatch, NewAccount } from "../entities";
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
}

export function createAccountsRepo(db: Database): AccountsRepo {
  async function get(id: number): Promise<Account | null> {
    const rows = await db.select<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`, [id]);
    return rows.length > 0 ? toAccount(rows[0]) : null;
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
      const result = await db.execute(
        "INSERT INTO accounts (name, kind, last4, gnucash_guid) VALUES (?, ?, ?, ?)",
        [account.name, account.kind, account.last4 ?? null, account.gnucash_guid ?? null],
      );
      const created = await get(result.lastInsertId);
      if (!created) throw new Error(`accounts.insert: row ${result.lastInsertId} missing`);
      return created;
    },

    async update(id, patch) {
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
  };
}
