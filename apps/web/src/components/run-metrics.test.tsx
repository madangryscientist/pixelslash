import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test } from "vitest";
import { branchWindow } from "#/db/run-metrics";
import { buildView } from "#/db/review";
import { context, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { branchMetrics } from "#/lib/branch-metrics";
import { byTestId } from "#/test/by-test-id";
import { BranchMetrics } from "./branch-metrics";
import { BuildTimings } from "./build-timings";
import { Provenance } from "./provenance";

/**
 * Metrics in the review UI (PS-233), from a real diffed build to the page: the build page's "This
 * run" card, the shot page's compare time and the branch page's window. The figures' words and
 * statistics are `lib/run-card`, `lib/run-metrics` and `lib/branch-metrics`' own tests; this proves
 * a build that went through the diff stores what the pages read, and the pages put it under their
 * test ids.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

let ctx: Awaited<ReturnType<typeof context>>;
let view: Awaited<ReturnType<typeof buildView>>;

beforeAll(async () => {
  ctx = await context();
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [
      { name: "hero", png: white },
      { name: "ticker", png: white },
    ],
  });
  const work = await upload(ctx, {
    branch: "work",
    commit: sha(2),
    mergeBase: sha(1),
    ancestors: [sha(1)],
    shots: [
      { name: "hero", png: red },
      { name: "ticker", png: white },
    ],
  });
  view = await buildView(ctx.db, ctx.projectId, work.id);
});

describe("a diffed build's page", () => {
  test("the run card states its wall time, counts and compare time, each with where it came from", () => {
    const html = renderToStaticMarkup(
      <BuildTimings
        build={view.build}
        shots={view.snapshots}
        defaultBranch="main"
        recaptures={null}
      />,
    );
    expect(byTestId(html, "run-wall-value")).toMatch(/\d/);
    expect(byTestId(html, "run-wall-source")).toContain("derived");
    expect(byTestId(html, "run-shots-value")).toBe("2");
    expect(byTestId(html, "run-compares-value")).toBe("1");
    // "ticker" is the same bytes as main: a snapshot of the build, and no compare ran.
    expect(byTestId(html, "run-cache-hits-value")).toBe("1");
    expect(byTestId(html, "run-unmeasured-value")).toBe("0");
    expect(byTestId(html, "run-compare-value")).toContain("2 snapshots · 1 compared");
    expect(byTestId(html, "run-compare-value")).toContain("p99 n/a (n = 1)");
    expect(byTestId(html, "run-compare-source")).toContain("stored by the server");
  });

  test("a feature branch states no auto-accept, the CLI sent no re-captures, no model ran, and timings were recorded", () => {
    const html = renderToStaticMarkup(
      <BuildTimings
        build={view.build}
        shots={view.snapshots}
        defaultBranch="main"
        recaptures={null}
      />,
    );
    for (const id of [
      "run-auto-accepted",
      "run-recaptures",
      "run-tokens-explain",
      "run-no-timings",
    ])
      expect(html).not.toContain(`data-testid="${id}"`);
  });

  test("the diffed shot states who measured it and its compare time", () => {
    const hero = view.snapshots.find((s) => s.name === "hero");
    if (!hero) throw new Error("no hero");
    const html = renderToStaticMarkup(<Provenance snapshot={hero} />);
    expect(byTestId(html, "measured-by")).toBe("PixelSlash server");
    expect(byTestId(html, "compare-time")).toMatch(/\d/);
  });
});

describe("the branch page's window", () => {
  test("states the builds, the wall time and the compare time with the n behind each, and draws no trend for one build", async () => {
    const metrics = branchMetrics(await branchWindow(ctx.db, ctx.projectId, "work"));
    const html = renderToStaticMarkup(<BranchMetrics metrics={metrics} />);
    expect(byTestId(html, "branch-metrics-window")).toContain(
      "Over the branch's last 20 builds: 1 build here.",
    );
    expect(byTestId(html, "branch-metrics-wall")).toContain("(n = 1 finished build)");
    expect(byTestId(html, "branch-metrics-compare-time")).toContain("(n = 1 shot)");
    // One build is a value, not a trend.
    expect(html).not.toContain('data-testid="branch-metrics-sparkline"');
    expect(html).not.toContain('data-testid="branch-metrics-pair"');
  });
});
