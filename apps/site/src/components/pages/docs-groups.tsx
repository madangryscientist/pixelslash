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

/**
 * The /docs landing's groups: a plain grid, so each li takes its row's height, which is accepted.
 * Get started spans the first row; when an odd number of groups follows it, the last spans its row too.
 */
export function DocsGroupGrid(): ReactNode {
  const oddTail = (GROUPS.length - 1) % 2 === 1;
  return (
    <ul data-testid="docs-index" className="m-0 grid list-none gap-6 p-0 md:grid-cols-2">
      {GROUPS.map((group, index) => (
        <li
          key={group.id}
          className={
            index === 0 || (oddTail && index === GROUPS.length - 1) ? "md:col-span-2" : undefined
          }
        >
          <div className="mb-3">
            <SubsectionHeading as="h2" size="lg">
              {group.title}
            </SubsectionHeading>
          </div>
          <Card>
            <p className="mb-3 text-sm text-slate-600">{group.summary}</p>
            <ul className="flex flex-col gap-1">
              {LISTED_PAGES.filter((page) => page.group === group.id).map((page) => (
                <li key={page.slug}>
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
