import type { Database } from "../db";
import type {
  Account,
  AccountKind,
  AccountPatch,
  AccountSubtype,
  AccountType,
  NewAccount,
} from "../entities";
import { EntityInUseError, ValidationError } from "../errors";
import { buildUpdate } from "./helpers";
import { createLedgerRepo, type LedgerRepo } from "./ledger";

interface AccountRow {
  id: number;
  name: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  parent_id: number | null;
  last4: string | null;
  gnucash_guid: string | null;
  archived: 0 | 1;
}

const COLUMNS = "id, name, type, subtype, parent_id, last4, gnucash_guid, archived";

/** Funding accounts: non-placeholder, non-system ASSET and LIABILITY accounts. */
const FUNDING_FILTER =
  "placeholder = 0 AND system_role IS NULL AND type IN ('ASSET', 'LIABILITY')";

const KIND_MAP: Record<AccountKind, { type: AccountType; subtype: AccountSubtype }> = {
  checking: { type: "ASSET", subtype: "bank" },
  cash: { type: "ASSET", subtype: "cash" },
  savings: { type: "ASSET", subtype: "savings" },
  credit: { type: "LIABILITY", subtype: "credit_card" },
  loan: { type: "LIABILITY", subtype: "loan" },
};

function deriveKind(type: AccountType, subtype: AccountSubtype | null): AccountKind {
  switch (subtype) {
    case "bank":
      return "checking";
    case "cash":
      return "cash";
    case "savings":
      return "savings";
    case "credit_card":
      return "credit";
    case "loan":
      return "loan";
    default:
      return type === "LIABILITY" ? "credit" : "checking";
  }
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    kind: deriveKind(row.type, row.subtype),
    type: row.type,
    subtype: row.subtype,
    parent_id: row.parent_id,
    last4: row.last4,
    gnucash_guid: row.gnucash_guid,
    archived: row.archived === 1,
  };
}

export interface AccountsRepo {
  /** Active funding accounts by default; pass `includeArchived` for the full set. */
  list(options?: { includeArchived?: boolean }): Promise<Account[]>;
  /** Fetch by id — returns archived accounts too; `null` for non-funding accounts. */
  get(id: number): Promise<Account | null>;
  insert(account: NewAccount): Promise<Account>;
  /** Apply a partial patch; returns the updated row, or null if `id` is not a funding account. */
  update(id: number, patch: AccountPatch): Promise<Account | null>;
  /** Soft-delete: hides from default lists, keeps payment history intact. */
  archive(id: number): Promise<boolean>;
  /** Hard delete only when not referenced by any rows. */
  delete(id: number): Promise<boolean>;
}

export function createAccountsRepo(
  db: Database,
  ledger: LedgerRepo = createLedgerRepo(db),
): AccountsRepo {
  async function get(id: number): Promise<Account | null> {
    const rows = await db.select<AccountRow>(
      `SELECT ${COLUMNS} FROM accounts WHERE id = ? AND ${FUNDING_FILTER}`,
      [id],
    );
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

  async function rootIdFor(type: AccountType): Promise<number> {
    const root = await ledger.getSystemAccount(type === "ASSET" ? "root_asset" : "root_liability");
    if (root === null) throw new ValidationError(`The ${type} root account is missing.`);
    return root.id;
  }

  return {
    async list({ includeArchived = false } = {}) {
      const archived = includeArchived ? "" : " AND archived = 0";
      const rows = await db.select<AccountRow>(
        `SELECT ${COLUMNS} FROM accounts WHERE ${FUNDING_FILTER}${archived} ORDER BY name, id`,
      );
      return rows.map(toAccount);
    },

    get,

    async insert(account) {
      assertValidNewAccount(account);
      const target = KIND_MAP[account.kind];
      const created = await ledger.insertAccount({
        name: account.name,
        type: target.type,
        subtype: target.subtype,
        parent_id: await rootIdFor(target.type),
        last4: account.last4 ?? null,
        gnucash_guid: account.gnucash_guid ?? null,
      });
      const facade = await get(created.id);
      if (!facade) throw new Error(`accounts.insert: row ${created.id} missing`);
      return facade;
    },

    async update(id, patch) {
      assertValidAccountPatch(patch);
      const existing = await get(id);
      if (!existing) return null;

      let type: AccountType | undefined;
      let subtype: AccountSubtype | undefined;
      let parentId: number | undefined;
      if (patch.kind !== undefined) {
        const target = KIND_MAP[patch.kind];
        if (target.type !== existing.type) {
          const children = await count("SELECT COUNT(*) AS count FROM accounts WHERE parent_id = ?", [
            id,
          ]);
          if (children > 0) {
            throw new ValidationError(
              "Cannot change the kind of an account that has child accounts.",
            );
          }
          type = target.type;
          parentId = await rootIdFor(target.type);
        }
        subtype = target.subtype;
      }

      const statement = buildUpdate(
        "accounts",
        {
          name: patch.name,
          type,
          subtype,
          parent_id: parentId,
          last4: patch.last4,
          gnucash_guid: patch.gnucash_guid,
        },
        id,
      );
      if (statement) await db.batch([statement]);
      return get(id);
    },

    async archive(id) {
      if ((await get(id)) === null) return false;
      return ledger.archiveAccount(id);
    },

    async delete(id) {
      const existing = await get(id);
      if (!existing) return false;

      const splitRefs = await count("SELECT COUNT(*) AS count FROM splits WHERE account_id = ?", [id]);
      if (splitRefs > 0) {
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

      return ledger.deleteAccount(id);
    },
  };
}
