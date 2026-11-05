/*
 * The docs search, as plain functions over a static index. The index is built at prerender
 * (search-index.ts) and served as one file from the site's own origin; the browser fetches it and
 * runs `search` on it. No service, no dependency.
 */

/** One section of one page: where it is, what it is called and its text. */
export type SearchEntry = {
  /** The page and anchor, e.g. `/docs/upload#baseline-rules`. */
  url: string;
  /** The page's title. */
  page: string;
  /** The section's heading (the page title for the text before its first heading). */
  heading: string;
  /** The section's text, code blocks included, so an exact error string is found. */
  text: string;
};

export type SearchHit = { entry: SearchEntry; score: number; snippet: string };

const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, " ");

/** About 140 characters of the text around `at`, cut at word edges. */
function around(text: string, at: number): string {
  const flat = text.replace(/\s+/g, " ");
  const start = Math.max(0, at - 50);
  const end = Math.min(flat.length, at + 90);
  const body = flat.slice(start, end).trim();
  return `${start > 0 ? "… " : ""}${body}${end < flat.length ? " …" : ""}`;
}

type Folded = { heading: string; page: string; text: string };

/** How well a folded entry answers the query, or `null` when too many of its words are missing. */
function scoreOf(
  { heading, page, text }: Folded,
  phrase: string,
  words: readonly string[],
): number | null {
  const everything = `${heading} ${page} ${text}`;
  // Two thirds of the words must be there: an error message is printed with its numbers filled in,
  // so the docs' `<n>/<m>` never matches the `0/1` a reader pastes, and the other words must still find it.
  const needed = Math.max(1, Math.ceil((words.length * 2) / 3));
  if (words.filter((word) => everything.includes(word)).length < needed) return null;
  const parts: [string, number, number][] = [
    [heading, 100, 10],
    [text, 60, 1],
    [page, 20, 3],
  ];
  return parts.reduce(
    (sum, [where, whole, each]) =>
      sum +
      (where.includes(phrase) ? whole : 0) +
      words.filter((word) => where.includes(word)).length * each,
    0,
  );
}

/**
 * Two thirds of the query's words must appear in the section, and more words rank higher. A phrase match counts most, then the
 * heading, then the page title; a section that holds the whole query as written ranks first, which
 * is how an exact error message finds the one entry that prints it.
 */
export function search(entries: readonly SearchEntry[], query: string, limit = 8): SearchHit[] {
  const phrase = fold(query).trim();
  if (phrase === "") return [];
  const words = [...new Set(phrase.split(" "))];
  const hits = entries.flatMap((entry): SearchHit[] => {
    const folded = { heading: fold(entry.heading), page: fold(entry.page), text: fold(entry.text) };
    const score = scoreOf(folded, phrase, words);
    if (score === null) return [];
    const found = folded.text.indexOf(phrase);
    const at = found >= 0 ? found : folded.text.indexOf(words[0] ?? "");
    return [{ entry, score, snippet: around(entry.text, Math.max(at, 0)) }];
  });
  return hits
    .toSorted((a, b) => b.score - a.score || a.entry.url.localeCompare(b.entry.url))
    .slice(0, limit);
}
