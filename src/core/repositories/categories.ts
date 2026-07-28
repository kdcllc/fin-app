import type { Database } from "../db";
import type { Category, CategoryPatch, NewCategory } from "../entities";
import { buildUpdate } from "./helpers";

// NOTE: schema v1 has no `archived` column on categories (unlike accounts and
// payees), so this repository has no archive operation. If category archiving
// is needed later it requires a schema migration first.

const COLUMNS = "id, name, parent_id, gnucash_guid";

export interface CategoriesRepo {
  list(): Promise<Category[]>;
  get(id: number): Promise<Category | null>;
  insert(category: NewCategory): Promise<Category>;
  /** Apply a partial patch; returns the updated row, or null if `id` is unknown. */
  update(id: number, patch: CategoryPatch): Promise<Category | null>;
}

export function createCategoriesRepo(db: Database): CategoriesRepo {
  async function get(id: number): Promise<Category | null> {
    const rows = await db.select<Category>(`SELECT ${COLUMNS} FROM categories WHERE id = ?`, [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  return {
    async list() {
      return db.select<Category>(`SELECT ${COLUMNS} FROM categories ORDER BY name, id`);
    },

    get,

    async insert(category) {
      const result = await db.execute(
        "INSERT INTO categories (name, parent_id, gnucash_guid) VALUES (?, ?, ?)",
        [category.name, category.parent_id ?? null, category.gnucash_guid ?? null],
      );
      const created = await get(result.lastInsertId);
      if (!created) throw new Error(`categories.insert: row ${result.lastInsertId} missing`);
      return created;
    },

    async update(id, patch) {
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
  };
}
