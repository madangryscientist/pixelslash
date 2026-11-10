import { use } from "react";
import { plainText } from "./doc-text.ts";
import { DOC_PAGES, type DocPageDef, findPage } from "./docs-map.ts";
import { type Doc, parseDoc } from "./markdown.tsx";

/*
 * The docs pages' documents, read from the repo at build time. A page renders what the file says
 * today; it never keeps a copy of its own, so the site cannot drift from the docs.
 *
 * Each page's text is its own chunk, loaded when that page is: the docs index and a page that is
 * a file of its own do not carry every other page's text, nor lex it as they hydrate (PS-357).
 * The server renders the whole page, since the route's loader has the document before the render.
 */

type DocFile = NonNullable<DocPageDef["file"]>;

/** The docs pages that are a repo file of their own, by the file. */
const FILE_SOURCES: Record<DocFile, () => Promise<{ default: string }>> = {
  "docs/getting-started.md": () => import("../../../../docs/getting-started.md?raw"),
  "docs/metrics.md": () => import("../../../../docs/metrics.md?raw"),
  "docs/tutorials/choose-capture.md": () =>
    import("../../../../docs/tutorials/choose-capture.md?raw"),
  "docs/tutorials/storybook.md": () => import("../../../../docs/tutorials/storybook.md?raw"),
  "docs/tutorials/playwright.md": () => import("../../../../docs/tutorials/playwright.md?raw"),
  "docs/tutorials/urls.md": () => import("../../../../docs/tutorials/urls.md?raw"),
  "docs/tutorials/pngs.md": () => import("../../../../docs/tutorials/pngs.md?raw"),
  "docs/tutorials/first-review.md": () => import("../../../../docs/tutorials/first-review.md?raw"),
  "docs/ci/github-actions.md": () => import("../../../../docs/ci/github-actions.md?raw"),
  "docs/ci/gitlab.md": () => import("../../../../docs/ci/gitlab.md?raw"),
  "docs/ci/circleci.md": () => import("../../../../docs/ci/circleci.md?raw"),
  "docs/ci/jenkins.md": () => import("../../../../docs/ci/jenkins.md?raw"),
  "docs/ci/any-ci.md": () => import("../../../../docs/ci/any-ci.md?raw"),
  "docs/ci/pin-versions.md": () => import("../../../../docs/ci/pin-versions.md?raw"),
  "docs/ci/review-server.md": () => import("../../../../docs/ci/review-server.md?raw"),
  "docs/concepts/how-a-comparison-works.md": () =>
    import("../../../../docs/concepts/how-a-comparison-works.md?raw"),
  "docs/concepts/baselines-and-branches.md": () =>
    import("../../../../docs/concepts/baselines-and-branches.md?raw"),
  "docs/concepts/thresholds.md": () => import("../../../../docs/concepts/thresholds.md?raw"),
  "docs/concepts/ignore-or-redact.md": () =>
    import("../../../../docs/concepts/ignore-or-redact.md?raw"),
  "docs/concepts/flaky-shots.md": () => import("../../../../docs/concepts/flaky-shots.md?raw"),
  "docs/concepts/fingerprints.md": () => import("../../../../docs/concepts/fingerprints.md?raw"),
  "docs/concepts/reading-a-report.md": () =>
    import("../../../../docs/concepts/reading-a-report.md?raw"),
  "docs/concepts/review-flow.md": () => import("../../../../docs/concepts/review-flow.md?raw"),
  "docs/help/exit-codes.md": () => import("../../../../docs/help/exit-codes.md?raw"),
  "docs/help/troubleshooting.md": () => import("../../../../docs/help/troubleshooting.md?raw"),
  "docs/help/faq.md": () => import("../../../../docs/help/faq.md?raw"),
  "docs/help/coming-from-chromatic.md": () =>
    import("../../../../docs/help/coming-from-chromatic.md?raw"),
};

async function parsePage(slug: string): Promise<Doc> {
  const page = findPage(slug);
  if (page === undefined) throw new Error(`docs: no page ${slug}`);
  if (page.file !== undefined) {
    const { default: markdown } = await FILE_SOURCES[page.file]();
    return parseDoc(markdown, page.file, slug);
  }
  const { cliDocOf } = await import("./cli-docs.ts");
  return cliDocOf(page);
}

/** A load React's `use` reads at once when it has settled: it never suspends a page it has. */
type Loading = Promise<Doc> & { status?: "fulfilled"; value?: Doc };

const LOADS = new Map<string, Loading>();

/** The document a docs page shows, loaded once: a cut of cli.md, or the page's own file. */
export function loadDoc(slug: string): Promise<Doc> {
  const known = LOADS.get(slug);
  if (known !== undefined) return known;
  const loading: Loading = parsePage(slug);
  void loading.then(
    (doc) => {
      loading.status = "fulfilled";
      loading.value = doc;
    },
    () => undefined,
  );
  LOADS.set(slug, loading);
  return loading;
}

/**
 * A page's document in a component. The route's loader loads it first, so the server and a
 * navigation render it at once; only hydration waits for its chunk, inside a Suspense boundary,
 * and keeps the server's HTML until then.
 */
export function useDoc(slug: string): Doc {
  return use(loadDoc(slug));
}

/** Every docs page's document, in nav order. */
export async function loadAllDocs(): Promise<ReadonlyMap<string, Doc>> {
  const entries = await Promise.all(
    DOC_PAGES.map(async (page): Promise<[string, Doc]> => [page.slug, await loadDoc(page.slug)]),
  );
  return new Map(entries);
}

const DESCRIPTION_MAX = 155;

/**
 * A paragraph as one line of plain text, cut at a sentence or else a word to fit a description. A
 * paragraph that leads into a code block ends in a colon, and a colon with nothing after it does not
 * read as a description, so it ends in a full stop instead.
 */
export function descriptionFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim().replace(/:$/, ".");
  if (line.length <= DESCRIPTION_MAX) return line;
  const head = line.slice(0, DESCRIPTION_MAX);
  const sentence = head.lastIndexOf(". ");
  if (sentence >= 60) return head.slice(0, sentence + 1);
  return `${head.slice(0, head.lastIndexOf(" ")).replace(/[,;:]$/, "")}…`;
}

/** A docs page's description: its own first paragraph, so it says what the page says. */
export function describePage(slug: string, doc: Doc): string {
  const page = DOC_PAGES.find((item) => item.slug === slug);
  const first = doc.tokens.find((token) => token.type === "paragraph");
  if (first?.type === "paragraph") {
    const text = plainText(first.tokens);
    if (text.length >= 40) return descriptionFrom(text);
  }
  return descriptionFrom(`${page?.title ?? slug}: part of the PixelSlash docs.`);
}
