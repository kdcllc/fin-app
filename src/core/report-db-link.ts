import type { Database } from "./db";

const reportDatabaseByRepos = new WeakMap<object, Database>();

/** @internal Wired by `createRepositories`; not part of the public Repositories surface. */
export function linkReportDatabase(repos: object, db: Database): void {
  reportDatabaseByRepos.set(repos, db);
}

export function getReportDatabase(repos: object): Database {
  const db = reportDatabaseByRepos.get(repos);
  if (!db) {
    throw new Error("Repositories are not wired for report queries.");
  }
  return db;
}
