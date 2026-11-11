import { Icon, Input } from "@hackcove/ui-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type SearchEntry, type SearchHit, search } from "../../content/search.ts";

const INDEX_URL = "/search-index.json";
const HINT = "Search the docs (press /)";

/** A key that types a character: a text field, a select or a contenteditable area (the rule `apps/web` uses too). */
function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable]") !== null
  );
}

function isEntries(value: unknown): value is SearchEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "url" in item &&
        typeof item.url === "string" &&
        "text" in item &&
        typeof item.text === "string",
    )
  );
}

async function fetchEntries(): Promise<SearchEntry[]> {
  const reply = await fetch(INDEX_URL);
  const body: unknown = reply.ok ? await reply.json() : null;
  if (!isEntries(body)) throw new Error("the search index did not load");
  return body;
}

/**
 * The docs search box: a static index fetched from this site's own origin the first time the box
 * is used, queried in the browser. It sends nothing anywhere.
 */
export function DocsSearch(): ReactNode {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<SearchEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const asked = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // `/` focuses this box when it is the one on screen. A box that is folded away (the rail on a
  // phone) is not visible, so the key does nothing for it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.ctrlKey || event.altKey || event.metaKey) return;
      if (isTextEntry(event.target)) return;
      const field = rootRef.current?.querySelector("input");
      if (!field || !field.checkVisibility()) return;
      event.preventDefault();
      field.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const load = (): void => {
    if (asked.current) return;
    asked.current = true;
    fetchEntries()
      .then(setEntries)
      .catch(() => setFailed(true));
  };

  const hits: SearchHit[] = entries && query.trim() !== "" ? search(entries, query) : [];
  const searching = query.trim() !== "";

  return (
    <div role="search" ref={rootRef} className="flex flex-col gap-2">
      <Input
        type="search"
        icon={<Icon name="search" />}
        aria-label="Search the docs"
        placeholder={query === "" ? HINT : undefined}
        data-testid="docs-search"
        value={query}
        onFocus={load}
        onChange={(event) => {
          setQuery(event.target.value);
          load();
        }}
      />
      {searching && failed ? (
        <p className="px-1 text-sm text-slate-600" data-testid="docs-search-status">
          The search index did not load. Reload the page to try again.
        </p>
      ) : null}
      {searching && entries && hits.length === 0 ? (
        <p className="px-1 text-sm text-slate-600" data-testid="docs-search-status">
          Nothing matches "{query.trim()}".
        </p>
      ) : null}
      {hits.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="docs-search-results">
          {hits.map((hit) => (
            <li key={hit.entry.url} className="text-sm/5">
              <a
                href={hit.entry.url}
                className="font-medium text-slate-900 hover:text-violet-700 hover:underline"
              >
                {hit.entry.heading}
              </a>
              <span className="block text-xs text-slate-500">{hit.entry.page}</span>
              <span className="block text-xs text-slate-600">{hit.snippet}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
