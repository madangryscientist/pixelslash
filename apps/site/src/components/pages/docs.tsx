import {
  Breadcrumbs,
  Button,
  Callout,
  Card,
  CardGrid,
  Disclosure,
  PageHeader,
  ProseLayout,
  SidebarLayout,
  Tabs,
  TextLink,
} from "@hackcove/ui-react";
import { type ReactNode, Suspense } from "react";
import { OLD_ANCHOR_SCRIPT } from "../../content/old-anchors.ts";
import { CLI_INTRO_DOC } from "../../content/cli-intro.ts";
import { useDoc } from "../../content/docs.ts";
import {
  type DocPageDef,
  EXTRA_NAV,
  GROUPS,
  LISTED_PAGES,
  findPage,
  neighbours,
} from "../../content/docs-map.ts";
import { REPO_PUBLIC, REPO_URL } from "../../content/links.ts";
import { DocBody, type Heading } from "../../content/markdown.tsx";
import { DocsGroupGrid } from "./docs-groups";
import { DocsSearch } from "./docs-search";
import { useActiveHeading } from "./use-active-heading";

// The themes' unlayered rule for text-slate-600 beats any layered hover:text-slate-*, so a slate hover
// would change nothing but the underline. hover:text-violet-700 is an accent both themes remap.
const NAV_LINK = "text-slate-600 hover:text-violet-700 hover:underline";

const pageHref = (page: DocPageDef): string => `/docs/${page.slug}`;

/** The rail's pages in one group: the map's pages, then the site pages that sit in the same group. */
function groupItems(groupId: string, current: string | undefined) {
  return [
    ...LISTED_PAGES.filter((page) => page.group === groupId).map((page) => ({
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
 * tall, so it is not the page's longest column. The /docs landing has no rail: its search box and
 * group cards sit in the content column instead.
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

/** One page of the docs: a cut of docs/cli.md, or a file of its own, rendered at build time. */
export function DocPage({ slug }: { slug: string }): ReactNode {
  return (
    <SidebarLayout rail={<DocsNav current={slug} />} railLabel="Docs">
      {/* Never shown: the loader has the document before a render. Hydration keeps the server's HTML while its chunk loads. */}
      <Suspense fallback={null}>
        <DocArticle slug={slug} />
      </Suspense>
    </SidebarLayout>
  );
}

/** The page's own column: its title, its text and its contents list. */
function DocArticle({ slug }: { slug: string }): ReactNode {
  const page = findPage(slug);
  if (page === undefined) throw new Error(`docs: no page ${slug}`);
  const doc = useDoc(slug);
  const group = GROUPS.find((candidate) => candidate.id === page.group);
  const hasRail = doc.headings.some((heading) => heading.depth <= 3);
  const breadcrumbs = (
    <Breadcrumbs crumbs={[{ label: "Docs", href: "/docs" }, group?.title ?? "", page.title]} />
  );
  const article = (
    <div className="flex flex-col gap-8">
      {hasRail && (
        <details className="rounded-md border border-slate-200 px-4 py-2 xl:hidden">
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
  );
  return (
    <div>
      <PageHeader title={page.title} breadcrumbs={breadcrumbs} />
      {/* The columns are sized to their content: the text takes the room, the contents list is 12rem from xl. The kit's DetailLayout gives its aside a third, which suits a details panel and not a contents list. */}
      <div className={hasRail ? "grid gap-6 xl:grid-cols-[minmax(0,1fr)_12rem]" : "grid gap-6"}>
        <div className="min-w-0" data-testid="docs-article">
          {article}
        </div>
        {hasRail && (
          // The kit's own sticky classes (STICKY_ASIDE_LG, STICKY_SCROLL_LG) at xl, which it does not export: stuck under the header, scrolling itself when taller than the room left.
          <aside className="hidden min-w-0 xl:sticky xl:top-[var(--app-header,0px)] xl:block xl:self-start">
            <div className="xl:-m-1 xl:max-h-[calc(100dvh-var(--app-header,0px)-2rem)] xl:overflow-y-auto xl:p-1">
              <nav aria-label="On this page" data-testid="docs-contents">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  On this page
                </p>
                <OnThisPage headings={doc.headings} track />
              </nav>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

/** Where a reader who has never run PixelSlash starts. */
const FIRST_STEP = {
  slug: "getting-started",
  action: "Run a first compare",
  text: "Install PixelSlash, compare two versions of a page and read the report. About fifteen minutes, all on your machine.",
} as const;

/** `/docs`: the search box, one first step, then every group. No rail: the cards run the full column. */
export function DocsIndexPage(): ReactNode {
  const first = findPage(FIRST_STEP.slug);
  if (first === undefined) throw new Error(`docs: no page ${FIRST_STEP.slug}`);
  return (
    <>
      {/* `/docs#anchor` links from before the split land on the page that holds the anchor. */}
      <script dangerouslySetInnerHTML={{ __html: OLD_ANCHOR_SCRIPT }} />
      <ProseLayout
        width="full"
        title="Docs"
        subtitle="Install PixelSlash, run a first compare, then look up whatever you are doing next."
      >
        <DocsSearch />
        <Callout
          tone="neutral"
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
        <div className="max-w-[75ch]" data-testid="docs-intro">
          <DocBody doc={CLI_INTRO_DOC} />
        </div>
        <DocsGroupGrid />
      </ProseLayout>
    </>
  );
}
