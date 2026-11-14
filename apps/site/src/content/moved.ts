/** Where the marketing pages live now: slashslash.build, the suite's own site. */
export const SLASHSLASH = "https://slashslash.build/pixelslash";

/**
 * The pages that left pixelslash.dev, in nav order. The Worker entry answers each path (with and
 * without a trailing slash) with a 301 to `target`, and the nav links straight to `target`.
 */
export const MOVED = [
  { from: "/", label: "Home", target: SLASHSLASH },
  { from: "/how-it-works", label: "How it works", target: `${SLASHSLASH}/how-it-works` },
  { from: "/compare", label: "Compare", target: `${SLASHSLASH}/compare` },
  { from: "/pricing", label: "Pricing", target: `${SLASHSLASH}/pricing` },
] as const;

/** Every path the Worker redirects, the trailing-slash form included, and where it goes. */
export const REDIRECTS: ReadonlyMap<string, string> = new Map(
  MOVED.flatMap(({ from, target }): [string, string][] =>
    from === "/"
      ? [[from, target]]
      : [
          [from, target],
          [`${from}/`, target],
        ],
  ),
);

/** Where a moved page went, by its old path. */
export function movedTo(from: (typeof MOVED)[number]["from"]): string {
  const target = REDIRECTS.get(from);
  if (target === undefined) throw new Error(`${from} is not a moved page`);
  return target;
}
