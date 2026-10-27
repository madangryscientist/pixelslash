/**
 * Selectors that matched nothing on a shot (PS-241). Warning on every shot buries the real warnings
 * (an `ignore: ["video"]` on a site where most pages have no video is a thousand lines a run), so the
 * misses are counted over the run and printed once per selector when it ends. A selector that
 * matched nothing on every shot it was checked on stays a warning: that is the likely typo.
 */
export type UnmatchedTally = {
  /**
   * A shot checked these selectors of `kind` (`ignore`, `mask`, `redact`), matched or not. Returns
   * the callback for a selector that matched nothing on this shot.
   */
  checked(kind: string, selectors: readonly string[]): (selector: string) => void;
  /** Print the summary and clear the tally, so a second flush prints nothing. */
  flush(): void;
};

type Count = { kind: string; selector: string; shots: number; misses: number };

export function unmatchedTally(warn: (message: string) => void): UnmatchedTally {
  const counts = new Map<string, Count>();
  const count = (kind: string, selector: string): Count => {
    const key = `${kind}\0${selector}`;
    const found = counts.get(key) ?? { kind, selector, shots: 0, misses: 0 };
    counts.set(key, found);
    return found;
  };
  return {
    checked(kind, selectors) {
      // A selector listed twice (global and route ignore) is one selector on the shot.
      const unique = new Set(selectors);
      for (const selector of unique) count(kind, selector).shots++;
      const missed = new Set<string>();
      return (selector) => {
        if (missed.has(selector)) return;
        missed.add(selector);
        count(kind, selector).misses++;
      };
    },
    flush() {
      for (const { kind, selector, shots, misses } of counts.values()) {
        if (misses === 0) continue;
        warn(
          misses === shots
            ? `warning: ${kind} "${selector}" matched no shot in this run`
            : `${kind} "${selector}" matched nothing on ${misses} of ${shots} shots`,
        );
      }
      counts.clear();
    },
  };
}
