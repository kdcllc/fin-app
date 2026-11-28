import type { Database } from "../db";
import type { Category, CategoryPatch, NewCategory } from "../entities";
import { EntityInUseError, ForeignKeyViolationError, ValidationError } from "../errors";
import { createLedgerRepo, type LedgerRepo } from "./ledger";

interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
  gnucash_guid: string | null;
  archived: 0 | 1;
}

const COLUMNS = "id, name, parent_id, gnucash_guid, archived";

/** Categories: EXPENSE accounts excluding the root and system accounts. */
const CATEGORY_FILTER = "type = 'EXPENSE' AND system_role IS NULL";

export interface CategoriesRepo {
  /** Active categories by default; pass `includeArchived` for the full set. */
  list(options?: { includeArchived?: boolean }): Promise<Category[]>;
  get(id: number): Promise<Category | null>;
  insert(category: NewCategory): Promise<Category>;
  /** Apply a partial patch; returns the updated row, or null if `id` is unknown. */
  update(id: number, patch: CategoryPatch): Promise<Category | null>;
  /** Soft-delete: hides from default lists, keeps payment history intact. */
  archive(id: number): Promise<boolean>;
  /** Hard delete only when not referenced by any rows. */
  delete(id: number): Promise<boolean>;
}

export function createCategoriesRepo(
  db: Database,
  ledger: LedgerRepo = createLedgerRepo(db),
): CategoriesRepo {
  async function rootExpenseId(): Promise<number> {
    const root = await ledger.getSystemAccount("root_expense");
    if (root === null) throw new ValidationError("The Expenses root account is missing.");
    return root.id;
  }

  function toCategory(row: CategoryRow, rootId: number): Category {
    return {
      id: row.id,
      name: row.name,
      parent_id: row.parent_id === rootId ? null : row.parent_id,
      gnucash_guid: row.gnucash_guid,
      archived: row.archived === 1,
    };
  }

  async function get(id: number): Promise<Category | null> {
    const rows = await db.select<CategoryRow>(
      `SELECT ${COLUMNS} FROM accounts WHERE id = ? AND ${CATEGORY_FILTER}`,
      [id],
    );
    return rows.length > 0 ? toCategory(rows[0], await rootExpenseId()) : null;
  }

  /** Resolve a facade `parent_id` to a parent account id (`null` → the expense root). */
  async function resolveParent(parentId: number | null | undefined): Promise<number> {
    if (parentId === undefined || parentId === null) return rootExpenseId();
    const parent = await ledger.getAccount(parentId);
    if (parent === null) {
      throw new ForeignKeyViolationError(`Parent category ${parentId} does not exist.`);
    }
    if (parent.type !== "EXPENSE" || parent.system_role !== null) {
      throw new ValidationError("A category's parent must be another expense category.");
    }
    return parent.id;
  }

  function assertValidNewCategory(category: NewCategory): void {
    if (category.name.trim().length === 0) {
      throw new ValidationError("Category name is required.");
    }
  }

  function assertValidCategoryPatch(id: number, patch: CategoryPatch): void {
    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw new ValidationError("Category name is required.");
    }
    if (patch.parent_id !== undefined && patch.parent_id !== null && patch.parent_id === id) {
      throw new ValidationError("Category cannot be its own parent.");
    }
  }

  async function count(sql: string, params: Array<string | number | null>): Promise<number> {
    const rows = await db.select<{ count: number }>(sql, params);
    return rows[0]?.count ?? 0;
  }

  return {
    async list({ includeArchived = false } = {}) {
      const archived = includeArchived ? "" : " AND archived = 0";
      const rows = await db.select<CategoryRow>(
        `SELECT ${COLUMNS} FROM accounts WHERE ${CATEGORY_FILTER}${archived} ORDER BY name, id`,
      );
      const rootId = await rootExpenseId();
      return rows.map((row) => toCategory(row, rootId));
    },

    get,

    async insert(category) {
      assertValidNewCategory(category);
      const parentId = await resolveParent(category.parent_id);
      const created = await ledger.insertAccount({
        name: category.name,
        type: "EXPENSE",
        parent_id: parentId,
        gnucash_guid: category.gnucash_guid ?? null,
      });
      const facade = await get(created.id);
      if (!facade) throw new Error(`categories.insert: row ${created.id} missing`);
      return facade;
    },

    async update(id, patch) {
      assertValidCategoryPatch(id, patch);
      if ((await get(id)) === null) return null;
      const parentId = patch.parent_id === undefined ? undefined : await resolveParent(patch.parent_id);
      await ledger.updateAccount(id, {
        name: patch.name,
        parent_id: parentId,
        gnucash_guid: patch.gnucash_guid,
      });
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
          "Cannot delete this category because payment history references it. Archive the category instead.",
        );
      }

      const payeeDefaultRefs = await count(
        "SELECT COUNT(*) AS count FROM payees WHERE default_category_id = ?",
        [id],
      );
      if (payeeDefaultRefs > 0) {
        throw new EntityInUseError(
          "Cannot delete this category because payee defaults still reference it.",
        );
      }

      const childRefs = await count("SELECT COUNT(*) AS count FROM accounts WHERE parent_id = ?", [id]);
      if (childRefs > 0) {
        throw new EntityInUseError(
          "Cannot delete this category because child categories still reference it.",
        );
      }

      // legacy_category_map rows go with the account (ON DELETE CASCADE).
      return ledger.deleteAccount(id);
    },
  };
}
