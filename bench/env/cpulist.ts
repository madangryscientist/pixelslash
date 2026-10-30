/** Linux CPU lists ("4-5,10-11", "4 5 10 11"): parse, format and the set operations the reserve needs (ob 1947). */

const MAX_CPU = 1023;

/** A strictly validated list: digits, `-`, `,` and spaces only. Sorted, no duplicates; throws on anything else. */
export function parseCpus(raw: string): number[] {
  const text = raw.trim();
  if (!/^[0-9]+(?:-[0-9]+)?(?:[, ][0-9]+(?:-[0-9]+)?)*$/.test(text))
    throw new Error(`not a CPU list: ${JSON.stringify(raw.slice(0, 40))}`);
  const cpus = new Set<number>();
  for (const part of text.split(/[, ]/)) {
    const [lo, hi = lo] = part.split("-").map(Number);
    if (lo === undefined || hi === undefined || lo > hi || hi > MAX_CPU)
      throw new Error(`not a CPU range: ${part}`);
    for (let c = lo; c <= hi; c += 1) cpus.add(c);
  }
  return [...cpus].toSorted((a, b) => a - b);
}

/** The shortest list form: `[4,5,10,11]` is "4-5,10-11". Empty for none. */
export function formatCpus(cpus: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < cpus.length;) {
    const first = cpus[i] ?? 0;
    let last = first;
    while (cpus[i + 1] === last + 1) {
      last += 1;
      i += 1;
    }
    i += 1;
    ranges.push(first === last ? String(first) : `${first}-${last}`);
  }
  return ranges.join(",");
}

export const without = (all: number[], drop: number[]): number[] =>
  all.filter((c) => !drop.includes(c));
