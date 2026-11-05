import readme from "../../../../README.md?raw";
import security from "../../../../SECURITY.md?raw";
import gettingStarted from "../../../../docs/getting-started.md?raw";
import metrics from "../../../../docs/metrics.md?raw";
import chooseCapture from "../../../../docs/tutorials/choose-capture.md?raw";
import tutorialStorybook from "../../../../docs/tutorials/storybook.md?raw";
import tutorialPlaywright from "../../../../docs/tutorials/playwright.md?raw";
import tutorialUrls from "../../../../docs/tutorials/urls.md?raw";
import tutorialPngs from "../../../../docs/tutorials/pngs.md?raw";
import tutorialFirstReview from "../../../../docs/tutorials/first-review.md?raw";
import ciGithubActions from "../../../../docs/ci/github-actions.md?raw";
import ciGitlab from "../../../../docs/ci/gitlab.md?raw";
import ciCircleci from "../../../../docs/ci/circleci.md?raw";
import ciJenkins from "../../../../docs/ci/jenkins.md?raw";
import ciAny from "../../../../docs/ci/any-ci.md?raw";
import ciPinVersions from "../../../../docs/ci/pin-versions.md?raw";
import ciReviewServer from "../../../../docs/ci/review-server.md?raw";
import conceptComparison from "../../../../docs/concepts/how-a-comparison-works.md?raw";
import conceptBaselines from "../../../../docs/concepts/baselines-and-branches.md?raw";
import conceptThresholds from "../../../../docs/concepts/thresholds.md?raw";
import conceptIgnore from "../../../../docs/concepts/ignore-or-redact.md?raw";
import conceptFlaky from "../../../../docs/concepts/flaky-shots.md?raw";
import conceptFingerprints from "../../../../docs/concepts/fingerprints.md?raw";
import conceptReport from "../../../../docs/concepts/reading-a-report.md?raw";
import conceptReview from "../../../../docs/concepts/review-flow.md?raw";
import helpExitCodes from "../../../../docs/help/exit-codes.md?raw";
import helpTroubleshooting from "../../../../docs/help/troubleshooting.md?raw";
import helpFaq from "../../../../docs/help/faq.md?raw";
import helpChromatic from "../../../../docs/help/coming-from-chromatic.md?raw";
import selfHost from "../../../web/SELF-HOST.md?raw";
import { CLI_SPLIT } from "./cli-pages.ts";
import { plainText } from "./doc-text.ts";
import { DOC_PAGES, findPage } from "./docs-map.ts";
import { type Doc, type Heading, parseDoc } from "./markdown.tsx";

/*
 * The repo's own documents, read at build time. A page renders what the file says today; it never
 * keeps a copy of its own, so the site cannot drift from the docs.
 */
export const SELF_HOST_DOC = parseDoc(selfHost, "apps/web/SELF-HOST.md");
export const SECURITY_DOC = parseDoc(security, "SECURITY.md");

function headingsOf(tokens: Doc["tokens"]): Heading[] {
  return tokens.flatMap((token) => {
    if (token.type !== "heading") return [];
    return [
      { depth: token.depth, text: plainText(token.tokens), id: CLI_SPLIT.ids.get(token) ?? "" },
    ];
  });
}

/** A cut of docs/cli.md as a document: its blocks keep the anchors GitHub gives them in the whole file. */
function cliDoc(tokens: Doc["tokens"], title: string, page?: string): Doc {
  return {
    source: "docs/cli.md",
    title,
    tokens,
    headings: headingsOf(tokens),
    ids: CLI_SPLIT.ids,
    ...(page === undefined ? {} : { page }),
  };
}

/** What docs/cli.md says before its first section: the index page leads with it. */
export const CLI_INTRO_DOC = cliDoc(CLI_SPLIT.preamble, CLI_SPLIT.title);

/** The docs pages that are a repo file of their own, by the file. */
const FILE_DOCS = {
  "docs/getting-started.md": parseDoc(gettingStarted, "docs/getting-started.md", "getting-started"),
  "docs/metrics.md": parseDoc(metrics, "docs/metrics.md", "metrics"),
  "docs/tutorials/choose-capture.md": parseDoc(
    chooseCapture,
    "docs/tutorials/choose-capture.md",
    "choose-capture",
  ),
  "docs/tutorials/storybook.md": parseDoc(
    tutorialStorybook,
    "docs/tutorials/storybook.md",
    "tutorial-storybook",
  ),
  "docs/tutorials/playwright.md": parseDoc(
    tutorialPlaywright,
    "docs/tutorials/playwright.md",
    "tutorial-playwright",
  ),
  "docs/tutorials/urls.md": parseDoc(tutorialUrls, "docs/tutorials/urls.md", "tutorial-urls"),
  "docs/tutorials/pngs.md": parseDoc(tutorialPngs, "docs/tutorials/pngs.md", "tutorial-pngs"),
  "docs/tutorials/first-review.md": parseDoc(
    tutorialFirstReview,
    "docs/tutorials/first-review.md",
    "tutorial-first-review",
  ),
  "docs/ci/github-actions.md": parseDoc(
    ciGithubActions,
    "docs/ci/github-actions.md",
    "ci-github-actions",
  ),
  "docs/ci/gitlab.md": parseDoc(ciGitlab, "docs/ci/gitlab.md", "ci-gitlab"),
  "docs/ci/circleci.md": parseDoc(ciCircleci, "docs/ci/circleci.md", "ci-circleci"),
  "docs/ci/jenkins.md": parseDoc(ciJenkins, "docs/ci/jenkins.md", "ci-jenkins"),
  "docs/ci/any-ci.md": parseDoc(ciAny, "docs/ci/any-ci.md", "ci-any"),
  "docs/ci/pin-versions.md": parseDoc(ciPinVersions, "docs/ci/pin-versions.md", "ci-pin-versions"),
  "docs/ci/review-server.md": parseDoc(
    ciReviewServer,
    "docs/ci/review-server.md",
    "ci-review-server",
  ),
  "docs/concepts/how-a-comparison-works.md": parseDoc(
    conceptComparison,
    "docs/concepts/how-a-comparison-works.md",
    "how-a-comparison-works",
  ),
  "docs/concepts/baselines-and-branches.md": parseDoc(
    conceptBaselines,
    "docs/concepts/baselines-and-branches.md",
    "baselines-and-branches",
  ),
  "docs/concepts/thresholds.md": parseDoc(
    conceptThresholds,
    "docs/concepts/thresholds.md",
    "thresholds",
  ),
  "docs/concepts/ignore-or-redact.md": parseDoc(
    conceptIgnore,
    "docs/concepts/ignore-or-redact.md",
    "ignore-or-redact",
  ),
  "docs/concepts/flaky-shots.md": parseDoc(
    conceptFlaky,
    "docs/concepts/flaky-shots.md",
    "flaky-shots",
  ),
  "docs/concepts/fingerprints.md": parseDoc(
    conceptFingerprints,
    "docs/concepts/fingerprints.md",
    "fingerprints",
  ),
  "docs/concepts/reading-a-report.md": parseDoc(
    conceptReport,
    "docs/concepts/reading-a-report.md",
    "reading-a-report",
  ),
  "docs/concepts/review-flow.md": parseDoc(
    conceptReview,
    "docs/concepts/review-flow.md",
    "review-flow",
  ),
  "docs/help/exit-codes.md": parseDoc(helpExitCodes, "docs/help/exit-codes.md", "exit-codes"),
  "docs/help/troubleshooting.md": parseDoc(
    helpTroubleshooting,
    "docs/help/troubleshooting.md",
    "troubleshooting",
  ),
  "docs/help/faq.md": parseDoc(helpFaq, "docs/help/faq.md", "faq"),
  "docs/help/coming-from-chromatic.md": parseDoc(
    helpChromatic,
    "docs/help/coming-from-chromatic.md",
    "coming-from-chromatic",
  ),
};

/** The document a docs page shows: a cut of cli.md, or the page's own file. */
export function docOf(slug: string): Doc {
  const page = findPage(slug);
  if (page === undefined) throw new Error(`docs: no page ${slug}`);
  if (page.file !== undefined) return FILE_DOCS[page.file];
  const tokens = CLI_SPLIT.pages.get(slug);
  if (tokens === undefined) throw new Error(`docs: page ${slug} has no sections`);
  return cliDoc(tokens, page.title, slug);
}

/** Every docs page's document, in nav order. */
export const DOC_PAGE_DOCS: ReadonlyMap<string, Doc> = new Map(
  DOC_PAGES.map((page) => [page.slug, docOf(page.slug)]),
);

/** The README's trademark sentence, verbatim (line breaks folded), for the footer. */
export function trademarkLine(markdown: string): string {
  const match = /PixelSlash is a name of[^.]*;[^.]*\./.exec(markdown.replace(/\s+/g, " "));
  if (!match) throw new Error("README.md no longer carries the trademark line the footer shows");
  return match[0];
}

export const TRADEMARK = trademarkLine(readme);
