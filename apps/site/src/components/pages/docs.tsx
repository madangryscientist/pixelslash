import {
  Breadcrumbs,
  Button,
  Callout,
  Card,
  CardGrid,
  DetailLayout,
  Disclosure,
  ProseLayout,
  SidebarLayout,
  Tabs,
  TextLink,
} from "@hackcove/ui-react";
import { type ReactNode, useEffect, useState } from "react";
import { CLI_SPLIT } from "../../content/cli-pages.ts";
import { CLI_INTRO_DOC, docOf } from "../../content/docs.ts";
import {
  DOC_PAGES,
  type DocPageDef,
  EXTRA_NAV,
  GROUPS,
  findPage,
  neighbours,
} from "../../content/docs-map.ts";
import { REPO_PUBLIC, REPO_URL } from "../../content/links.ts";
import { DocBody, type Heading } from "../../content/markdown.tsx";
import { DocsSearch } from "./docs-search";

// The themes' unlayered rule for text-slate-600 beats any layered hover:text-slate-*, so a slate hover
// would change nothing but the underline. hover:text-violet-700 is an accent both themes remap.
const NAV_LINK = "text-slate-600 hover:text-violet-700 hover:underline";

const pageHref = (page: DocPageDef): string => `/docs/${page.slug}`;

/** The rail's pages in one group: the map's pages, then the site pages that sit in the same group. */
function groupItems(groupId: string, current: string | undefined) {
  return [
    ...DOC_PAGES.filter((page) => page.group === groupId).map((page) => ({
      label: page.title,
      href: pageHref(page),
      active: page.slug === current,
    })),
    ...EXTRA_NAV.filter((extra) => extra.group === groupId).map((extra) => ({
      label: extra.title,
      href: extra.href,
      active: extra.href === current,
    })),
  ];
}

/**
 * The rail: the search box, then each group as a fold, only the one holding the current page open.
 * `current` is a slug or, for a page outside the map, its path. Folded, the rail is one screen
 * tall, so it is not the page's longest column.
 */
export function DocsNav({ current }: { current?: string }): ReactNode {
  return (
    <nav aria-label="Docs" data-testid="docs-nav" className="flex flex-col gap-4">
      <DocsSearch />
      <Tabs
        variant="pill"
        orientation="vertical"
        size="sm"
        label="Docs overview"
        items={[{ label: "All docs", href: "/docs", active: current === undefined }]}
      />
      <div className="flex flex-col">
        {GROUPS.map((group) => {
          const items = groupItems(group.id, current);
          const open = items.some((item) => item.active);
          return (
            // Keyed by `open`: a group the reader navigates into is rebuilt open, since the fold keeps its own state.
            <Disclosure
              key={`${group.id}-${open}`}
              summary={group.title}
              defaultOpen={open}
              data-testid={`docs-group-${group.id}`}
            >
              <Tabs
                variant="pill"
                orientation="vertical"
                size="sm"
                label={group.title}
                items={items}
              />
            </Disclosure>
          );
        })}
      </div>
    </nav>
  );
}

/** The id of the heading the reader is in: the last one whose top has passed the header, the first before any has. */
function useActiveHeading(key: string, track: boolean): string | undefined {
  const [active, setActive] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!track) return undefined;
    // Heading ids are slugs, so `|` never occurs in one; `key` is how a new page is noticed.
    const ids = key.split("|");
    // Just under the sticky header and nav row; a heading anchor lands on 7.5rem (styles.css).
    const line = 140;
    let frame = 0;
    const update = (): void => {
      frame = 0;
      let found: string | undefined = ids[0];
      for (const id of ids) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top === undefined) continue;
        if (top > line) break;
        found = id;
      }
      setActive(found);
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [key, track]);
  return active;
}

/** The page's own H2 and H3, each linking to its anchor in the body. With `track`, the heading being read is marked. */
function OnThisPage({
  headings,
  track = false,
}: {
  headings: Heading[];
  track?: boolean;
}): ReactNode {
  const shown = headings.filter((heading) => heading.depth <= 3);
  const active = useActiveHeading(shown.map((heading) => heading.id).join("|"), track);
  return (
    <ul className="flex flex-col gap-1 text-sm/6">
      {shown.map((heading) => {
        const here = heading.id === active;
        return (
          <li key={heading.id} className={heading.depth === 3 ? "pl-3" : undefined}>
            <a
              href={`#${heading.id}`}
              aria-current={here ? "location" : undefined}
              className={here ? "font-medium text-violet-700" : NAV_LINK}
            >
              {heading.text}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** A page that can end a run non-zero says where the numbers are explained. */
function ExitsLine(): ReactNode {
  return (
    <p className="text-sm/6 text-slate-600" data-testid="docs-exits">
      This command can end with a non-zero exit code.{" "}
      <TextLink href="/docs/exit-codes">Exit codes</TextLink> says what each number means.
    </p>
  );
}

/** Edit-on-GitHub for the file a page is cut from. Shown only once the repository is public. */
export function EditLink({ source }: { source: string }): ReactNode {
  if (!REPO_PUBLIC) return null;
  return (
    <p className="text-sm/6 text-slate-600" data-testid="docs-edit">
      <TextLink href={`${REPO_URL}/edit/main/${source}`}>Edit this page on GitHub</TextLink>
    </p>
  );
}

function PrevNext({ slug }: { slug: string }): ReactNode {
  const { prev, next } = neighbours(slug);
  if (!prev && !next) return null;
  return (
    <nav aria-label="Previous and next" data-testid="docs-prev-next">
      <CardGrid columns={2}>
        {prev ? (
          <Card
            href={pageHref(prev)}
            title={`Previous: ${prev.title}`}
            size="sm"
            data-testid="docs-prev"
          >
            {GROUPS.find((group) => group.id === prev.group)?.title}
          </Card>
        ) : (
          <div />
        )}
        {next ? (
          <Card
            href={pageHref(next)}
            title={`Next: ${next.title}`}
            size="sm"
            data-testid="docs-next"
          >
            {GROUPS.find((group) => group.id === next.group)?.title}
          </Card>
        ) : (
          <div />
        )}
      </CardGrid>
    </nav>
  );
}

/** One page of the docs: a cut of docs/cli.md (or getting-started.md), rendered at build time. */
export function DocPage({ slug }: { slug: string }): ReactNode {
  const page = findPage(slug);
  if (page === undefined) throw new Error(`docs: no page ${slug}`);
  const doc = docOf(slug);
  const group = GROUPS.find((candidate) => candidate.id === page.group);
  const hasRail = doc.headings.some((heading) => heading.depth <= 3);
  return (
    <SidebarLayout rail={<DocsNav current={slug} />} railLabel="Docs">
      <DetailLayout
        title={page.title}
        breadcrumbs={
          <Breadcrumbs
            crumbs={[{ label: "Docs", href: "/docs" }, group?.title ?? "", page.title]}
          />
        }
        aside={
          hasRail ? (
            <nav
              aria-label="On this page"
              data-testid="docs-contents"
              className="hidden lg:sticky lg:top-32 lg:block"
            >
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                On this page
              </p>
              <OnThisPage headings={doc.headings} track />
            </nav>
          ) : null
        }
      >
        <div className="flex flex-col gap-8">
          {hasRail && (
            <details className="rounded-md border border-slate-200 px-4 py-2 lg:hidden">
              <summary className="cursor-pointer text-sm font-medium">On this page</summary>
              <div className="py-2">
                <OnThisPage headings={doc.headings} />
              </div>
            </details>
          )}
          <DocBody doc={doc} />
          {page.exits === true ? <ExitsLine /> : null}
          <EditLink source={doc.source} />
          <PrevNext slug={slug} />
        </div>
      </DetailLayout>
    </SidebarLayout>
  );
}

/** Where a reader who has never run PixelSlash starts. */
const FIRST_STEP = {
  slug: "getting-started",
  action: "Run a first compare",
  text: "Install PixelSlash, compare two versions of a page and read the report. About fifteen minutes, all on your machine.",
} as const;

/** `/docs`: one first step, then every group. */
export function DocsIndexPage(): ReactNode {
  const first = findPage(FIRST_STEP.slug);
  if (first === undefined) throw new Error(`docs: no page ${FIRST_STEP.slug}`);
  return (
    <SidebarLayout rail={<DocsNav />} railLabel="Docs">
      <ProseLayout
        title="Docs"
        subtitle="Install PixelSlash, run a first compare, then look up whatever you are doing next."
      >
        <Callout
          title="New here? Start with the first compare"
          actions={
            <Button href={pageHref(first)} data-testid="docs-first-step">
              {FIRST_STEP.action}
            </Button>
          }
          data-testid="docs-start"
        >
          {FIRST_STEP.text}
        </Callout>
        <DocBody doc={CLI_INTRO_DOC} />
        <CardGrid columns={2} as="ul" data-testid="docs-index">
          {GROUPS.map((group) => (
            <Card key={group.id} title={group.title}>
              <p className="mb-2 text-sm text-slate-600">{group.summary}</p>
              <ul className="flex flex-col gap-1">
                {DOC_PAGES.filter((page) => page.group === group.id).map((page) => (
                  <li key={page.slug}>
                    <TextLink href={pageHref(page)}>{page.title}</TextLink>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </CardGrid>
      </ProseLayout>
    </SidebarLayout>
  );
}

/**
 * `/docs#anchor` was the one page before the split. A hash never reaches the server, so the index
 * carries the answer: a tiny script that sends an old anchor to the page that now holds it.
 */
export function oldAnchorScript(anchorPage: ReadonlyMap<string, string>): string {
  const map = JSON.stringify(Object.fromEntries(anchorPage));
  return `(function(){var h=decodeURIComponent(location.hash.slice(1));if(!h)return;var m=${map};if(Object.prototype.hasOwnProperty.call(m,h))location.replace("/docs/"+m[h]+"#"+h)})()`;
}

export const OLD_ANCHOR_SCRIPT = oldAnchorScript(CLI_SPLIT.anchorPage);
