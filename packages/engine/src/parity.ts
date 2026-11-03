import type { MetricsPart } from "./metrics-entry.ts";
import { useOf, type Sides } from "./parity-declarations.ts";
import { LABELS, allowedColor, kindOf, read, same, scaleOf } from "./parity-fields.ts";
import {
  PARITY_FIELDS,
  PARITY_PLATFORMS,
  isColorField,
  type Declaration,
  type ParityField,
  type ParityManifest,
  type ParityPlatform,
} from "./parity-manifest.ts";
import type {
  DeclarationUse,
  Mismatch,
  ParitySide,
  ParitySideInfo,
  ParityPair,
} from "./parity-types.ts";

/**
 * Metrics parity between twin snapshots (PS-296). Pure: two parsed metrics files, each side's
 * platform and scale, and the manifest in; mismatches out. No I/O, so the CLI, `pixelslash mcp`
 * and later the server call the same function. The contract is `docs/metrics.md`.
 */

export { staleDeclarations } from "./parity-declarations.ts";
export type * from "./parity-types.ts";

type Cmp = { sides: Sides; tol: number; manifest: ParityManifest; applicable: Declaration[] };

/** A part and its two sides' values, in platform order, as a clause: `button height 38 web vs 40 android`. */
function clause(m: Mismatch, a: ParityPlatform, b: ParityPlatform, named: boolean): string {
  if (m.field === null) return `${m.part} missing on ${m.values[a] === null ? a : b}`;
  const label = `${m.part} ${LABELS[m.field]}`;
  const [va, vb] = [String(m.values[a]), String(m.values[b])];
  return named ? `${label} ${va} ${a} vs ${vb} ${b}` : `${label} ${va} vs ${vb}`;
}

function makeMismatch(m: Omit<Mismatch, "sentence">, a: ParityPlatform, b: ParityPlatform) {
  const out: Mismatch = { ...m, sentence: "" };
  out.sentence = clause(out, a, b, true);
  return out;
}

/** The sentence for a pair: clauses per part, joined by `;`, the first value clause naming the platforms. */
function lineOf(
  head: string,
  mismatches: Mismatch[],
  a: ParityPlatform,
  b: ParityPlatform,
): string | null {
  if (mismatches.length === 0) return null;
  let named = true;
  const clauses = mismatches.map((m) => {
    const text = clause(m, a, b, named);
    if (m.field !== null) named = false;
    return text;
  });
  return `${head}: ${clauses.join("; ")}`;
}

/** A web/native colour pair the manifest lists. Two native sides have no allowlist. */
function colorAllowed(f: ParityField, cmp: Cmp, va: string | number, vb: string | number): boolean {
  const [sa, sb] = cmp.sides;
  return (
    isColorField(f) && sa.platform === "web" && allowedColor(cmp.manifest, va, vb, sb.platform)
  );
}

type FieldResult = { mismatch?: Mismatch; declared?: Mismatch; uses: DeclarationUse[] };

function compareField(f: ParityField, part: string, pair: [MetricsPart, MetricsPart], cmp: Cmp) {
  const [sa, sb] = cmp.sides;
  const [va, vb] = [read(pair[0], f), read(pair[1], f)];
  const uses = cmp.applicable
    .filter((d) => d.part === part)
    .flatMap((d) => useOf(d, f, cmp, [va, vb]) ?? []);
  const result: FieldResult = { uses };
  // A field either side did not measure is not compared, and is never read as 0.
  if (va === undefined || vb === undefined || same(f, va, vb, cmp.tol)) return result;
  if (colorAllowed(f, cmp, va, vb)) return result;
  const m = makeMismatch(
    { part, field: f, kind: kindOf(f), values: { [sa.platform]: va, [sb.platform]: vb } },
    sa.platform,
    sb.platform,
  );
  if (uses.some((u) => u.status === "applied")) result.declared = m;
  else result.mismatch = m;
  return result;
}

function missingPart(part: string, a: MetricsPart | undefined, sides: Sides): Mismatch {
  const [sa, sb] = sides;
  const [present, gone] = a === undefined ? [sb, sa] : [sa, sb];
  return makeMismatch(
    {
      part,
      field: null,
      kind: "missing-part",
      values: { [present.platform]: "present", [gone.platform]: null },
    },
    sa.platform,
    sb.platform,
  );
}

const info = (s: ParitySide): ParitySideInfo => ({
  platform: s.platform,
  scale: scaleOf(s.scale),
  scale_source: s.scale === null ? "default" : "recorded",
});

/** Compares one pair of twin snapshots. Sides are ordered web, android, ios whatever order they come in. */
export function compareParity(input: {
  name: string;
  theme: string;
  a: ParitySide;
  b: ParitySide;
  manifest: ParityManifest;
}): ParityPair {
  const { name, theme, manifest } = input;
  const sides: Sides =
    PARITY_PLATFORMS.indexOf(input.a.platform) <= PARITY_PLATFORMS.indexOf(input.b.platform)
      ? [input.a, input.b]
      : [input.b, input.a];
  const [sa, sb] = sides;
  const cmp: Cmp = {
    sides,
    tol: Math.max(1 / scaleOf(sa.scale), 1 / scaleOf(sb.scale)),
    manifest,
    applicable: manifest.differences.filter((d) => d.key === name || d.key === `${name} ${theme}`),
  };
  const mismatches: Mismatch[] = [];
  const declared: Mismatch[] = [];
  const declarations: DeclarationUse[] = [];
  const partsA = sa.metrics.parts;
  const partsB = sb.metrics.parts;
  for (const part of [
    ...Object.keys(partsA),
    ...Object.keys(partsB).filter((n) => !(n in partsA)),
  ]) {
    const [pa, pb] = [partsA[part], partsB[part]];
    if (pa === undefined || pb === undefined) {
      mismatches.push(missingPart(part, pa, sides));
      continue;
    }
    for (const r of PARITY_FIELDS.map((f) => compareField(f, part, [pa, pb], cmp))) {
      if (r.mismatch) mismatches.push(r.mismatch);
      if (r.declared) declared.push(r.declared);
      declarations.push(...r.uses);
    }
  }
  return {
    name,
    theme,
    sides: [info(sa), info(sb)],
    tolerance: cmp.tol,
    mismatches,
    declared,
    declarations,
    line: lineOf(`${name} ${theme}`, mismatches, sa.platform, sb.platform),
  };
}
