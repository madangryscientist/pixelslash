/**
 * D1 refuses a statement with more than 100 bound parameters (ob 1773). A list that grows with a
 * build or a project (an `IN (...)` of shot ids, a multi-row insert) is sent in parts that each
 * stay under it, counting the statement's other parameters.
 */
export const MAX_PARAMS = 100;

/**
 * Split `items` into parts that fit one statement: each item binds `perItem` parameters, and the
 * statement binds `other` more beside the list. Duplicates are dropped first, so a merged read of
 * an `IN` list returns each row once, as the single statement would.
 */
export function chunk<T>(items: readonly T[], other: number, perItem = 1): T[][] {
  const size = Math.floor((MAX_PARAMS - other) / perItem);
  if (size < 1) throw new Error(`a statement binding ${other} + ${perItem} parameters cannot fit`);
  const distinct = [...new Set(items)];
  const parts: T[][] = [];
  for (let at = 0; at < distinct.length; at += size) parts.push(distinct.slice(at, at + size));
  return parts;
}

/** Read once per part of `items` (see `chunk`), one after another, and merge the rows in part order. */
export async function inChunks<T, R>(
  items: readonly T[],
  other: number,
  read: (part: T[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (const part of chunk(items, other)) out.push(...(await read(part)));
  return out;
}
