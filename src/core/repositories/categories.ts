import type { Database } from "../db";
import type { Category, CategoryPatch, NewCategory } from "../entities";
import { EntityInUseError, ValidationError } from "../errors";
import { resolveInsertedRow } from "./insert-verify";
import { buildUpdate } from "./helpers";

interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
  gnucash_guid: string | null;
  archived: 0 | 1;
}

const COLUMNS = "id, name, parent_id, gnucash_guid, archived";

function toCategory(row: CategoryRow): Category {
  return { ...row, archived: row.archived === 1 };
}

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

export function createCategoriesRepo(db: Database): CategoriesRepo {
  async function get(id: number): Promise<Category | null> {
    const rows = await db.select<CategoryRow>(`SELECT ${COLUMNS} FROM categories WHERE id = ?`, [id]);
    return rows.length > 0 ? toCategory(rows[0]) : null;
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

  function matchesPayload(row: Category, category: NewCategory): boolean {
    return (
      row.name === category.name &&
      row.parent_id === (category.parent_id ?? null) &&
      row.gnucash_guid === (category.gnucash_guid ?? null)
    );
  }

  async function findByPayload(category: NewCategory): Promise<Category[]> {
    const rows = await db.select<CategoryRow>(
      `SELECT ${COLUMNS}
       FROM categories
       WHERE name = ?
         AND parent_id IS ?
         AND gnucash_guid IS ?
         AND archived = 0
       ORDER BY id DESC
       LIMIT 2`,
      [category.name, category.parent_id ?? null, category.gnucash_guid ?? null],
    );
    return rows.map(toCategory);
  }

  return {
    async list({ includeArchived = false } = {}) {
      const where = includeArchived ? "" : " WHERE archived = 0";
      const rows = await db.select<CategoryRow>(
        `SELECT ${COLUMNS} FROM categories${where} ORDER BY name, id`,
      );
      return rows.map(toCategory);
    },

    get,

    async insert(category) {
      assertValidNewCategory(category);
      const result = await db.execute(
        "INSERT INTO categories (name, parent_id, gnucash_guid) VALUES (?, ?, ?)",
        [category.name, category.parent_id ?? null, category.gnucash_guid ?? null],
      );
      return resolveInsertedRow({
        context: "categories.insert",
        lastInsertId: result.lastInsertId,
        payload: category,
        getById: get,
        payloadMatches: matchesPayload,
        findByPayload,
      });
    },

    async update(id, patch) {
      assertValidCategoryPatch(id, patch);
      const statement = buildUpdate(
        "categories",
        {
          name: patch.name,
          parent_id: patch.parent_id,
          gnucash_guid: patch.gnucash_guid,
        },
        id,
      );
      if (statement) await db.execute(statement.sql, statement.params);
      return get(id);
    },

    async archive(id) {
      const result = await db.execute("UPDATE categories SET archived = 1 WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },

    async delete(id) {
      const existing = await get(id);
      if (!existing) return false;

      const paymentRefs = await count("SELECT COUNT(*) AS count FROM payments WHERE category_id = ?", [id]);
      if (paymentRefs > 0) {
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

      const childRefs = await count("SELECT COUNT(*) AS count FROM categories WHERE parent_id = ?", [id]);
      if (childRefs > 0) {
        throw new EntityInUseError(
          "Cannot delete this category because child categories still reference it.",
        );
      }

      const result = await db.execute("DELETE FROM categories WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },
  };
}
