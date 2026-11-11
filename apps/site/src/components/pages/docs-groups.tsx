import { Card, SubsectionHeading, TextLink } from "@hackcove/ui-react";
import type { ReactNode } from "react";
import { GROUPS, LISTED_PAGES } from "../../content/docs-map.ts";

/** The trailing mark on an index link. Decorative: the link's name is its title. */
function LinkChevron(): ReactNode {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="ml-1 inline-block h-3.5 w-3.5 align-[-0.1em]"
    >
      <path
        fillRule="evenodd"
        d="M7.2 4.8a.75.75 0 0 1 1.06 0l4.7 4.67a.75.75 0 0 1 0 1.06l-4.7 4.67a.75.75 0 1 1-1.06-1.06L11.37 10 7.2 5.86a.75.75 0 0 1 0-1.06Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** A group with more than this many listed links spans the row and lists them in two columns. */
const LONG_GROUP = 8;

/**
 * The /docs landing's groups, in `GROUPS` order, on a two-column grid (PS-385). A group with more
 * than 8 listed links spans the row and lists its links in two columns; Get started spans the
 * first row. The rest pair up: walking in order, a group that would sit alone in a row (the next
 * group spans, or it is the last) spans too, so no half row is left empty. Each group is a grid of
 * its heading over a card that fills the rest, so the cards in one row end level.
 */
export function DocsGroupGrid(): ReactNode {
  const pages = GROUPS.map((group) => LISTED_PAGES.filter((page) => page.group === group.id));
  const long = pages.map((list) => list.length > LONG_GROUP);
  const spans: boolean[] = [];
  let column = 0;
  GROUPS.forEach((_, index) => {
    const last = index === GROUPS.length - 1;
    const nextSpans = !last && long[index + 1] === true;
    const span = index === 0 || long[index] === true || (column === 0 && (last || nextSpans));
    spans.push(span);
    column = span ? 0 : column + 1;
    if (column === 2) column = 0;
  });
  return (
    <ul data-testid="docs-index" className="m-0 grid list-none gap-6 p-0 md:grid-cols-2">
      {GROUPS.map((group, index) => (
        <li
          key={group.id}
          className={
            spans[index] ? "grid grid-rows-[auto_1fr] md:col-span-2" : "grid grid-rows-[auto_1fr]"
          }
        >
          <div className="mb-3">
            <SubsectionHeading as="h2" size="lg">
              {group.title}
            </SubsectionHeading>
          </div>
          <Card>
            <p className="mb-3 text-sm text-slate-600">{group.summary}</p>
            <ul
              className={
                long[index]
                  ? "flex flex-col gap-1 md:block md:columns-2 md:gap-x-6"
                  : "flex flex-col gap-1"
              }
            >
              {pages[index]?.map((page) => (
                <li
                  key={page.slug}
                  className={long[index] ? "md:mb-1 break-inside-avoid" : undefined}
                >
                  <TextLink href={`/docs/${page.slug}`}>
                    {page.title}
                    <LinkChevron />
                  </TextLink>
                </li>
              ))}
            </ul>
          </Card>
        </li>
      ))}
    </ul>
  );
}
