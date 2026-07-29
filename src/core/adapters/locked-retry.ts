import { DatabaseLockedError, mapSqliteError } from "../errors";

export const LOCK_RETRY_DELAYS_MS = [50, 100, 150, 250, 350, 500, 750, 1000];

export type SleepFn = (ms: number) => Promise<void>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withDatabaseLockedRetry<T>(
  work: () => Promise<T>,
  {
    sleep = defaultSleep,
    delaysMs = LOCK_RETRY_DELAYS_MS,
  }: {
    sleep?: SleepFn;
    delaysMs?: number[];
  } = {},
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const mapped = mapSqliteError(error);
      if (!(mapped instanceof DatabaseLockedError) || attempt === delaysMs.length) {
        throw mapped;
      }
      lastError = mapped;
      await sleep(delaysMs[attempt]);
    }
  }

  throw lastError ?? new DatabaseLockedError("database lock retry exhausted");
}
