/**
 * A shot's name is a key, not a title: the Storybook capture slugs `<title> <story>` into one
 * hyphenated run and appends `@<global>=<value>` per global (`ui-callout-tones@theme=default`).
 * The review wants the words, so this splits the globals off as variants and reads the component
 * from the build's own names: a prefix that another story shares is the component, the rest is
 * the story. A name that shares nothing stays whole rather than guess a split.
 */

export type ShotLabel = {
  component: string | null;
  story: string;
  /** The `@key=value` globals in the name, in order. */
  variants: { key: string; value: string }[];
};

function split(name: string): { base: string; variants: ShotLabel["variants"] } {
  const [base = name, ...globals] = name.split("@");
  const variants = globals.flatMap((global) => {
    const at = global.indexOf("=");
    return at > 0 ? [{ key: global.slice(0, at), value: global.slice(at + 1) }] : [];
  });
  return { base, variants };
}

const sentence = (words: string[]) => {
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** `catppuccin-mocha` → `Catppuccin Mocha`, for a chip. */
export function titleWords(text: string): string {
  return text
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The chips on a card. The shot's `theme` column is the capture's colour scheme, not the Storybook
 * theme, so a name's own `@theme=` global is the theme chip and the column is shown only when the
 * name says nothing about a theme. Other globals follow as `Key: Value`.
 */
export function shotChips(shot: { theme: string; viewport: string }, label: ShotLabel): string[] {
  const named = label.variants.find((variant) => variant.key === "theme");
  const chips = [titleWords(named ? named.value : shot.theme), shot.viewport];
  for (const variant of label.variants) {
    if (variant.key !== "theme")
      chips.push(`${titleWords(variant.key)}: ${titleWords(variant.value)}`);
  }
  return chips.filter((chip) => chip.length > 0);
}

/**
 * Only what the name says: its `@theme=` global as the theme, then the other globals as
 * `Key: Value`. The snapshot page shows the capture's colour scheme apart, as what it is.
 */
export function variantChips(label: ShotLabel): string[] {
  const theme = label.variants.find((variant) => variant.key === "theme");
  const others = label.variants
    .filter((variant) => variant.key !== "theme")
    .map((variant) => `${titleWords(variant.key)}: ${titleWords(variant.value)}`);
  return [...(theme ? [titleWords(theme.value)] : []), ...others].filter((chip) => chip.length > 0);
}

function sharedSegments(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * The labeller for one build: the component of a name is the longest run of leading segments it
 * shares with any other story in `names`, as long as a story is left over.
 */
export function shotLabeller(names: string[]): (name: string) => ShotLabel {
  const bases = [...new Set(names.map((name) => split(name).base))].map((base) => ({
    base,
    segments: base.split("-").filter(Boolean),
  }));
  const componentLength = new Map<string, number>();
  for (const one of bases) {
    let best = 0;
    for (const other of bases) {
      if (other === one) continue;
      const shared = sharedSegments(one.segments, other.segments);
      if (shared < one.segments.length) best = Math.max(best, shared);
    }
    componentLength.set(one.base, best);
  }
  return (name) => {
    const { base, variants } = split(name);
    const segments = base.split("-").filter(Boolean);
    const length = componentLength.get(base) ?? 0;
    if (length === 0 || segments.length === 0) {
      return {
        component: null,
        story: sentence(segments.length > 0 ? segments : [name]),
        variants,
      };
    }
    return {
      component: sentence(segments.slice(0, length)),
      story: sentence(segments.slice(length)),
      variants,
    };
  };
}
