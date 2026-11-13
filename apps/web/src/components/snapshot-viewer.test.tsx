import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { BaselineBuild } from "#/db/baseline-build";
import type { DiffRegion, DiffResult } from "#/db/diff-json";
import { formatNumber, formatPercent } from "#/lib/format";
import { type BaseId, basesOf, type BasesInput } from "#/lib/viewer-bases";
import { SnapshotViewer, type ViewState } from "./snapshot-viewer";

/**
 * The left pane names what it shows (PS-433): main's baseline only when that is the image, else the
 * earlier build of the branch. A carried shot opens on main, where its change is.
 */

const MAIN = "/img/main-baseline.png";
const PREVIOUS = "/img/previous-build.png";
const BRANCH = "/img/branch.png";

const region = (x: number): DiffRegion => ({
  x,
  y: 4,
  w: 20,
  h: 10,
  changedPixels: 200,
  antialiasedPixels: 0,
  kind: "change",
});

const result = (over: Partial<DiffResult>): DiffResult => ({
  changedPixels: 0,
  antialiasedPixels: 0,
  ignoredPixels: 0,
  ignored: [],
  specks: { count: 0, pixels: 0 },
  regions: [],
  width: 100,
  height: 50,
  mainWidth: 100,
  mainHeight: 50,
  branchWidth: 100,
  branchHeight: 50,
  sizeChanged: false,
  ...over,
});

/** Identical to the previous build; 400 px and two regions different from main. */
const againstPrevious = result({ settledBy: "identical-bytes" });
const againstMain = result({ changedPixels: 400, regions: [region(5), region(40)] });

const earlier: BaselineBuild = {
  snapshotId: "snap-1",
  buildId: "build-1",
  branch: "feat",
  commitSha: "50d549b1234",
  isDefaultBranch: false,
};
const mainsBuild: BaselineBuild = { ...earlier, branch: "main", isDefaultBranch: true };

const input = (
  over: Omit<Partial<BasesInput>, "snapshot"> & { snapshot?: Partial<BasesInput["snapshot"]> },
) => ({
  branch: "feat",
  baselineBuild: earlier,
  images: { main: PREVIOUS, mainBaseline: MAIN, diff: null },
  ...over,
  snapshot: {
    carriedFrom: "snap-1",
    diffResult: againstPrevious,
    mainDiffStatus: "changed" as const,
    mainDiffResult: againstMain,
    ...over.snapshot,
  },
});

function render(given: BasesInput, base: BaseId | null = null) {
  const bases = basesOf(given, { number: formatNumber, percent: formatPercent });
  const view: ViewState = {
    mode: "side",
    onMode: () => {},
    scale: "fit",
    onScale: () => {},
    base: base ? { snapshotId: "shot-2", id: base } : null,
    onBase: () => {},
  };
  const html = renderToStaticMarkup(
    <SnapshotViewer
      snapshotId="shot-2"
      bases={bases}
      name="about"
      mainUrl={given.images.main}
      branchUrl={BRANCH}
      diffUrl={given.images.diff}
      result={given.snapshot.diffResult}
      removed={false}
      view={view}
      panel={null}
    />,
  );
  const text = (testId: string) =>
    [...html.matchAll(new RegExp(`data-testid="${testId}"[^>]*>(.*?)</`, "g"))].map((m) =>
      (m[1] ?? "").replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'"),
    );
  const labels = [...html.matchAll(/data-testid="pane-label"[^>]*>(.*?)<\/figcaption>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return { html, text, labels, boxes: (html.match(/<rect /g) ?? []).length };
}

test("a shot compared with main's baseline keeps the label Main (baseline), with no switch", () => {
  const out = render(
    input({
      baselineBuild: mainsBuild,
      images: { main: MAIN, mainBaseline: null, diff: null },
      snapshot: { carriedFrom: null, diffResult: againstMain },
    }),
  );
  expect(out.labels[0]).toMatch(/^Main \(baseline\)/);
  expect(out.html).not.toContain('data-testid="base-switch"');
  expect(out.html).toContain(`src="${MAIN}"`);
});

test("a carried shot's left pane is labelled with the earlier build, never Main, while that pair is shown", () => {
  const out = render(input({}), "build");
  expect(out.labels[0]).toMatch(/^Earlier build on this branch 50d549b/);
  expect(out.labels[0]).not.toContain("Main");
  expect(out.html).toContain(`src="${PREVIOUS}"`);
  expect(out.html).not.toContain(`src="${MAIN}"`);
  expect(out.html).toContain('alt="about on the earlier build"');
  // Its own result is the empty one: identical bytes, nothing to box.
  expect(out.text("base-summary")[0]).toBe("No change: identical bytes, not diffed.");
  expect(out.boxes).toBe(0);
});

test("a carried shot with no main measurement is not labelled Main either", () => {
  const out = render(input({ snapshot: { mainDiffStatus: null, mainDiffResult: null } }));
  expect(out.labels[0]).toMatch(/^Earlier build on this branch/);
});

test("a carried shot opens on Against main: main's image, its boxes and its pixel count", () => {
  const out = render(input({}));
  expect(out.labels[0]).toMatch(/^Main \(baseline\)/);
  expect(out.html).toContain(`src="${MAIN}"`);
  expect(out.html).not.toContain(`src="${PREVIOUS}"`);
  expect(out.html).toContain('aria-label="Measured regions"');
  // Two regions, drawn on each of the two panes, with no click on Highlight.
  expect(out.boxes).toBe(4);
  expect(out.text("base-summary")[0]).toBe("400 changed px (8.0%) in 2 regions");
  expect(out.html).toContain("Against main");
  expect(out.html).toContain("Against build 50d549b");
  expect(out.html).toContain('data-testid="base-switch"');
});

test("a shot that is not carried opens on the earlier build, with the switch to main", () => {
  const out = render(
    input({ snapshot: { carriedFrom: null, diffResult: result({ changedPixels: 10 }) } }),
  );
  expect(out.labels[0]).toMatch(/^Earlier build on this branch/);
  expect(out.html).toContain('data-testid="base-switch"');
  expect(out.boxes).toBe(0);
});

test("a shot not measured against main has no switch and says so", () => {
  const out = render(input({ snapshot: { mainDiffStatus: null, mainDiffResult: null } }));
  expect(out.html).not.toContain("Against main");
  expect(out.text("base-note")).toEqual(["This shot was not measured against main."]);
});

test("a shot identical to main's baseline has no switch and says so", () => {
  const out = render(
    input({ snapshot: { mainDiffStatus: "unchanged", mainDiffResult: result({}) } }),
  );
  expect(out.html).not.toContain("Against main");
  expect(out.text("base-note")).toEqual(["Identical to main's baseline."]);
});

test("a shot new against main offers main with no baseline image and says it is new", () => {
  const out = render(
    input({
      images: { main: PREVIOUS, mainBaseline: null, diff: null },
      snapshot: { mainDiffStatus: "new", mainDiffResult: null },
    }),
  );
  expect(out.labels[0]).toMatch(/^Main \(baseline\)/);
  expect(out.html).toContain("No baseline to compare with.");
  expect(out.text("base-summary")[0]).toBe("New against main: main has no such shot.");
});

test("a choice made on another shot does not carry over to this one", () => {
  const bases = basesOf(input({}), { number: formatNumber, percent: formatPercent });
  const view: ViewState = {
    mode: "side",
    onMode: () => {},
    scale: "fit",
    onScale: () => {},
    base: { snapshotId: "another-shot", id: "build" },
    onBase: () => {},
  };
  const html = renderToStaticMarkup(
    <SnapshotViewer
      snapshotId="shot-2"
      bases={bases}
      name="about"
      mainUrl={PREVIOUS}
      branchUrl={BRANCH}
      diffUrl={null}
      result={againstPrevious}
      removed={false}
      view={view}
      panel={null}
    />,
  );
  expect(html).toContain(`src="${MAIN}"`);
});

test("the slider and the onion title name the earlier build by its sha, not just 'Earlier build'", () => {
  const bases = basesOf(input({}), { number: formatNumber, percent: formatPercent });
  expect(bases.options.map((option) => option.names.short)).toEqual(["Main", "Build 50d549b"]);
});
