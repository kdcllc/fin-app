export async function resolveInsertedRow<TEntity, TPayload>({
  context,
  lastInsertId,
  payload,
  getById,
  payloadMatches,
  findByPayload,
}: {
  context: string;
  lastInsertId: number;
  payload: TPayload;
  getById: (id: number) => Promise<TEntity | null>;
  payloadMatches: (entity: TEntity, payload: TPayload) => boolean;
  findByPayload: (payload: TPayload) => Promise<TEntity[]>;
}): Promise<TEntity> {
  const byId = await getById(lastInsertId);
  if (byId !== null && payloadMatches(byId, payload)) {
    return byId;
  }

  const matches = await findByPayload(payload);
  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    if (byId === null) {
      throw new Error(`${context}: row ${lastInsertId} missing and no payload match`);
    }
    throw new Error(
      `${context}: row ${lastInsertId} does not match inserted payload and no payload match`,
    );
  }

  throw new Error(`${context}: payload query is ambiguous (${matches.length} rows)`);
}
