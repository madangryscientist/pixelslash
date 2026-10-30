/** Shared by the argv parsers of `bench` and `bench:perf`: the pieces `--impl` and `--timeout-ms` need twice. */

/** Walks argv; `value(flag)` takes the next word as the flag's value. */
export function argvReader(argv: string[], usage: string) {
  let i = 0;
  return {
    next: (): string | undefined => argv[i++],
    value(flag: string): string {
      const v = argv[i++];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value\n${usage}`);
      return v;
    },
  };
}

export function positiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a whole number, 1 or more`);
  return n;
}
