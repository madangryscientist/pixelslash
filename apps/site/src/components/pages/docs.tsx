import {
  Breadcrumbs,
  Card,
  CardGrid,
  DetailLayout,
  ProseLayout,
  SidebarLayout,
  Tabs,
  TextLink,
} from "@hackcove/ui-react";
import type { ReactNode } from "react";
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

/** The rail: the search box, then every group and every page in it, the current page marked. `current` is a slug or, for a page outside the map, its path. */
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
      {GROUPS.map((group) => (
        <div key={group.id} className="flex flex-col gap-1">
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {group.title}
          </p>
          <Tabs
            variant="pill"
            orientation="vertical"
            size="sm"
            label={group.title}
            items={[
              ...DOC_PAGES.filter((page) => page.group === group.id).map((page) => ({
                label: page.title,
                href: pageHref(page),
                active: page.slug === current,
              })),
              ...EXTRA_NAV.filter((extra) => extra.group === group.id).map((extra) => ({
                label: extra.title,
                href: extra.href,
                active: extra.href === current,
              })),
            ]}
          />
        </div>
      ))}
    </nav>
  );
}

/** The page's own H2 and H3, each linking to its anchor in the body. */
function OnThisPage({ headings }: { headings: Heading[] }): ReactNode {
  return (
    <ul className="flex flex-col gap-1 text-sm/6">
      {headings
        .filter((heading) => heading.depth <= 3)
        .map((heading) => (
          <li key={heading.id} className={heading.depth === 3 ? "pl-3" : undefined}>
            <a href={`#${heading.id}`} className={NAV_LINK}>
              {heading.text}
            </a>
          </li>
        ))}
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
              <OnThisPage headings={doc.headings} />
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
          {page.exits === true && slug !== "exit-codes" ? <ExitsLine /> : null}
          <DocBody doc={doc} />
          <EditLink source={doc.source} />
          <PrevNext slug={slug} />
        </div>
      </DetailLayout>
    </SidebarLayout>
  );
}

/** `/docs`: the group index, led by the blurb docs/cli.md opens with. */
export function DocsIndexPage(): ReactNode {
  return (
    <SidebarLayout rail={<DocsNav />} railLabel="Docs">
      <ProseLayout
        title="Docs"
        subtitle="The CLI reference, split by what you are doing. It is docs/cli.md from the repository, as it is at this commit."
      >
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
