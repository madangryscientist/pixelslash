import { same } from "./parity-fields.ts";
import type { Declaration, ParityField, ParityValue } from "./parity-manifest.ts";
import type {
  DeclarationStatus,
  DeclarationUse,
  ParitySide,
  StaleDeclaration,
} from "./parity-types.ts";

/** Declared differences: where one stands in a pair, and which are stale across a build (PS-296). */

export type Sides = [ParitySide, ParitySide];

const declaredOn = (d: Declaration, side: ParitySide, f: ParityField): ParityValue | undefined =>
  d.platforms[side.platform]?.[f];

/** Why a declaration the pair disagrees with no longer holds, naming the side that moved. */
function movedDetail(
  cmp: { sides: Sides; tol: number },
  f: ParityField,
  want: [ParityValue, ParityValue],
  got: [ParityValue, ParityValue],
): string {
  const side = same(f, got[0], want[0], cmp.tol) ? 1 : 0;
  return `${cmp.sides[side]?.platform} is ${got[side]}, declared ${want[side]}`;
}

/** Where each side's value stands against a declaration, for one field of one part. */
export function useOf(
  d: Declaration,
  f: ParityField,
  cmp: { sides: Sides; tol: number },
  values: [ParityValue | undefined, ParityValue | undefined],
): DeclarationUse | null {
  const { sides, tol } = cmp;
  const da = declaredOn(d, sides[0], f);
  const db = declaredOn(d, sides[1], f);
  if (da === undefined || db === undefined) return null;
  const use = (status: DeclarationStatus, detail: string): DeclarationUse => ({
    key: d.key,
    part: d.part,
    field: f,
    status,
    detail,
  });
  const [va, vb] = values;
  if (va === undefined) return use("unmeasured", `${f} is not measured on ${sides[0].platform}`);
  if (vb === undefined) return use("unmeasured", `${f} is not measured on ${sides[1].platform}`);
  if (same(f, va, vb, tol)) return use("agreed", `both sides agree now (${va})`);
  if (same(f, va, da, tol) && same(f, vb, db, tol)) return use("applied", "");
  return use("moved", movedDetail(cmp, f, [da, db], [va, vb]));
}

/**
 * Declarations that applied in no pair of the build, though some pair carried their snapshot and
 * part: the web or native value moved, or the two now agree. They are reported, never failed on.
 * A declaration whose snapshot is not in the build is not stale, only not in play.
 */
export function staleDeclarations(pairs: { declarations: DeclarationUse[] }[]): StaleDeclaration[] {
  const byId = new Map<string, { use: DeclarationUse; applied: boolean }>();
  for (const pair of pairs)
    for (const use of pair.declarations) {
      const id = JSON.stringify([use.key, use.part, use.field]);
      const seen = byId.get(id);
      byId.set(id, {
        use: seen?.use ?? use,
        applied: (seen?.applied ?? false) || use.status === "applied",
      });
    }
  return [...byId.values()]
    .filter((e) => !e.applied)
    .map(({ use }) => ({
      key: use.key,
      part: use.part,
      field: use.field,
      sentence: `stale declaration: ${use.key} ${use.part} ${use.field}: ${use.detail}`,
    }));
}
