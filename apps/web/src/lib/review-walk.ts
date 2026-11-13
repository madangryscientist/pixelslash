/**
 * Where a shot sits in the j/k walk: the build's order, so a walk visits every shot once. Null when
 * the shot is not in the build.
 */
export function walkAround<T extends { id: string }>(
  rows: readonly T[],
  id: string,
): {
  shot: T;
  position: number;
  total: number;
  previousId: string | null;
  nextId: string | null;
} | null {
  const index = rows.findIndex((row) => row.id === id);
  const shot = rows[index];
  if (!shot) return null;
  return {
    shot,
    position: index + 1,
    total: rows.length,
    previousId: rows[index - 1]?.id ?? null,
    nextId: rows[index + 1]?.id ?? null,
  };
}
