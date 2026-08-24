import type { Account, Category } from "./entities";
import type { GnucashAccount, GnucashAccountType } from "./gnucash-types";
import type { Repositories } from "./index";

/** Thrown when applying a mapping would duplicate a GUID within an entity kind. */
export class GnucashMappingConflictError extends Error {
  constructor(message = "GnuCash GUID already mapped to another entity") {
    super(message);
    this.name = "GnucashMappingConflictError";
  }
}

export type MappingKind = "account" | "category";

export interface MappingSuggestion {
  kind: MappingKind;
  finEntityId: number;
  gnucashGuid: string;
  reason: string;
}

export interface MappingStatus {
  unmappedFinAccounts: Account[];
  unmappedCategories: Category[];
  unmappedGnucashAccounts: GnucashAccount[];
}

const ACCOUNT_ELIGIBLE_TYPES = new Set<GnucashAccountType>([
  "BANK",
  "CASH",
  "CREDIT",
  "LIABILITY",
]);

function collapseWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function normalizeLabel(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

function eligibleAccountTargets(gnucashAccounts: GnucashAccount[]): GnucashAccount[] {
  return gnucashAccounts
    .filter(
      (account) =>
        !account.placeholder && ACCOUNT_ELIGIBLE_TYPES.has(account.account_type),
    )
    .sort((a, b) => a.guid.localeCompare(b.guid));
}

function eligibleCategoryTargets(gnucashAccounts: GnucashAccount[]): GnucashAccount[] {
  return gnucashAccounts
    .filter((account) => !account.placeholder && account.account_type === "EXPENSE")
    .sort((a, b) => a.guid.localeCompare(b.guid));
}

function pathSegments(fullPath: string): string[] {
  return fullPath.split(":").map((segment) => normalizeLabel(segment));
}

function findAccountSuggestion(
  finAccount: Account,
  candidates: GnucashAccount[],
): MappingSuggestion | null {
  const normalizedName = normalizeLabel(finAccount.name);

  for (const candidate of candidates) {
    if (normalizeLabel(candidate.name) === normalizedName) {
      return {
        kind: "account",
        finEntityId: finAccount.id,
        gnucashGuid: candidate.guid,
        reason: `Name match: "${finAccount.name}" ↔ "${candidate.name}"`,
      };
    }
  }

  if (finAccount.last4 !== null && /^\d{4}$/.test(finAccount.last4)) {
    for (const candidate of candidates) {
      if (candidate.name.includes(finAccount.last4)) {
        return {
          kind: "account",
          finEntityId: finAccount.id,
          gnucashGuid: candidate.guid,
          reason: `Last4 match: fin account last4 "${finAccount.last4}" found in "${candidate.name}"`,
        };
      }
    }
  }

  return null;
}

function findCategorySuggestion(
  category: Category,
  candidates: GnucashAccount[],
): MappingSuggestion | null {
  const normalizedName = normalizeLabel(category.name);

  for (const candidate of candidates) {
    if (normalizeLabel(candidate.name) === normalizedName) {
      return {
        kind: "category",
        finEntityId: category.id,
        gnucashGuid: candidate.guid,
        reason: `Name match: "${category.name}" ↔ "${candidate.name}"`,
      };
    }
  }

  for (const candidate of candidates) {
    if (pathSegments(candidate.full_path).includes(normalizedName)) {
      const matchedSegment =
        candidate.full_path.split(":").find((segment) => normalizeLabel(segment) === normalizedName) ??
        category.name;
      return {
        kind: "category",
        finEntityId: category.id,
        gnucashGuid: candidate.guid,
        reason: `Path segment match: "${category.name}" in "${candidate.full_path}" (${matchedSegment})`,
      };
    }
  }

  return null;
}

export function suggestAccountMappings(
  finAccounts: Account[],
  gnucashAccounts: GnucashAccount[],
): MappingSuggestion[] {
  const candidates = eligibleAccountTargets(gnucashAccounts);
  const suggestions: MappingSuggestion[] = [];

  const unmapped = finAccounts
    .filter((account) => account.gnucash_guid === null)
    .sort((a, b) => a.id - b.id);

  for (const finAccount of unmapped) {
    const suggestion = findAccountSuggestion(finAccount, candidates);
    if (suggestion) suggestions.push(suggestion);
  }

  return suggestions.sort((a, b) => {
    const byFin = a.finEntityId - b.finEntityId;
    return byFin !== 0 ? byFin : a.gnucashGuid.localeCompare(b.gnucashGuid);
  });
}

export function suggestCategoryMappings(
  categories: Category[],
  gnucashAccounts: GnucashAccount[],
): MappingSuggestion[] {
  const candidates = eligibleCategoryTargets(gnucashAccounts);
  const suggestions: MappingSuggestion[] = [];

  const unmapped = categories
    .filter((category) => category.gnucash_guid === null)
    .sort((a, b) => a.id - b.id);

  for (const category of unmapped) {
    const suggestion = findCategorySuggestion(category, candidates);
    if (suggestion) suggestions.push(suggestion);
  }

  return suggestions.sort((a, b) => {
    const byFin = a.finEntityId - b.finEntityId;
    return byFin !== 0 ? byFin : a.gnucashGuid.localeCompare(b.gnucashGuid);
  });
}

async function assertNoAccountGuidConflict(
  repos: Repositories,
  accountId: number,
  guid: string,
): Promise<void> {
  const accounts = await repos.accounts.list({ includeArchived: true });
  const conflict = accounts.find(
    (account) => account.id !== accountId && account.gnucash_guid === guid,
  );
  if (conflict) {
    throw new GnucashMappingConflictError(
      `GnuCash GUID "${guid}" is already mapped to account "${conflict.name}" (id ${conflict.id})`,
    );
  }
}

async function assertNoCategoryGuidConflict(
  repos: Repositories,
  categoryId: number,
  guid: string,
): Promise<void> {
  const categories = await repos.categories.list({ includeArchived: true });
  const conflict = categories.find(
    (category) => category.id !== categoryId && category.gnucash_guid === guid,
  );
  if (conflict) {
    throw new GnucashMappingConflictError(
      `GnuCash GUID "${guid}" is already mapped to category "${conflict.name}" (id ${conflict.id})`,
    );
  }
}

export async function applyAccountMapping(
  repos: Repositories,
  accountId: number,
  guid: string,
): Promise<void> {
  await assertNoAccountGuidConflict(repos, accountId, guid);
  await repos.accounts.update(accountId, { gnucash_guid: guid });
}

export async function applyCategoryMapping(
  repos: Repositories,
  categoryId: number,
  guid: string,
): Promise<void> {
  await assertNoCategoryGuidConflict(repos, categoryId, guid);
  await repos.categories.update(categoryId, { gnucash_guid: guid });
}

export async function clearMapping(
  repos: Repositories,
  kind: "account" | "category",
  id: number,
): Promise<void> {
  if (kind === "account") {
    await repos.accounts.update(id, { gnucash_guid: null });
    return;
  }
  await repos.categories.update(id, { gnucash_guid: null });
}

export function mappingStatus(
  finAccounts: Account[],
  categories: Category[],
  gnucashAccounts: GnucashAccount[],
): MappingStatus {
  const mappedGuids = new Set<string>();
  for (const account of finAccounts) {
    if (account.gnucash_guid !== null) mappedGuids.add(account.gnucash_guid);
  }
  for (const category of categories) {
    if (category.gnucash_guid !== null) mappedGuids.add(category.gnucash_guid);
  }

  return {
    unmappedFinAccounts: finAccounts.filter((account) => account.gnucash_guid === null),
    unmappedCategories: categories.filter((category) => category.gnucash_guid === null),
    unmappedGnucashAccounts: gnucashAccounts.filter((account) => !mappedGuids.has(account.guid)),
  };
}
