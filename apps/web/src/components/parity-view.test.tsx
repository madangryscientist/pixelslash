import { describe, expect, test } from "vitest";
import {
  MANIFEST_NOTICE,
  type ParityPairView,
  type ParityShotColumn,
  type ParityView,
  missingColumn,
  pairSideOf,
  physicalSize,
  similarityText,
} from "#/lib/parity-view";
import { renderRouted, textOf } from "#/test/render-routed";
import { ParityBody } from "./parity-view";

/**
 * The parity view's screen: the columns in order, the physical size, the hint, the metrics
 * sentences and the notice. What the columns hold and what the metrics say is `api/parity.test.ts`.
 */

const source = { kind: "build", commitSha: null } as const;

function shotColumn(
  over: Partial<ParityShotColumn> & Pick<ParityShotColumn, "platform" | "snapshotId">,
): ParityShotColumn {
  const device = { web: null, android: "Pixel 8 API 35", ios: "iPhone 15" }[over.platform];
  const size = over.platform === "web" ? { width: 160, height: 120 } : { width: 480, height: 360 };
  const scale = over.platform === "web" ? null : 3;
  return {
    kind: "shot",
    device,
    viewport: over.platform === "web" ? "1280x720" : "412x915",
    label: device ? `${over.platform} · ${device}` : "web",
    source,
    scale,
    size,
    physical: physicalSize(size, scale),
    imageUrl: `/img/${over.snapshotId}`,
    stale: null,
    hasMetrics: true,
    similarity: null,
    buildId: "b1",
    projectId: "p1",
    projectName: "parity",
    ...over,
  };
}

const web = shotColumn({ platform: "web", snapshotId: "web-1" });
const android = shotColumn({
  platform: "android",
  snapshotId: "android-1",
  similarity: { against: null, score: 0.93, text: similarityText(0.93) },
});
const ios = shotColumn({ platform: "ios", snapshotId: "ios-1", hasMetrics: false });

const heightPair: ParityPairView = {
  a: pairSideOf(web),
  b: pairSideOf(android),
  status: "drift",
  lacks: [],
  mismatches: ["button height 40 web vs 44 android"],
  declared: [],
  tolerance: null,
};

const view = (columns: ParityView["columns"], pairs: ParityPairView[]): ParityView => ({
  name: "Button/primary",
  theme: "dark",
  columns,
  metrics: { manifest: false, notice: MANIFEST_NOTICE, pairs, rawColumns: [], raw: [] },
});

const count = (html: string, testId: string) => html.split(`data-testid="${testId}"`).length - 1;

describe("the parity view with a web and an android shot", () => {
  const two = view([web, android, missingColumn("Button/primary", "dark", "ios")], [heightPair]);

  test("draws web then android, then the platform with no shot, saying so", async () => {
    const html = await renderRouted(<ParityBody view={two} />);
    expect(count(html, "parity-column")).toBe(2);
    const order = [...html.matchAll(/data-testid="parity-column"[^>]*data-platform="(\w+)"/g)];
    expect(order.map((m) => m[1])).toEqual(["web", "android"]);
    expect(textOf(html)).toContain("Pixel 8 API 35");
    expect(count(html, "parity-missing")).toBe(1);
    expect(textOf(html)).toContain("Button/primary dark has no ios twin");
  });

  test("both shots are drawn at the same physical size: 160 x 120 px at 1x and 480 x 360 px at 3x", async () => {
    const html = await renderRouted(<ParityBody view={two} />);
    const sizes = [...html.matchAll(/<p [^>]*data-testid="parity-physical"[^>]*>.*?<\/p>/g)].map(
      (m) => textOf(m[0]),
    );
    expect(sizes).toEqual(["160 × 120 px at 1x (not recorded)", "160 × 120 px at 3x"]);
  });

  test("the similarity is labelled a hint", async () => {
    const html = await renderRouted(<ParityBody view={two} />);
    expect(count(html, "parity-similarity")).toBe(1);
    expect(textOf(html)).toContain("similarity 0.93, a hint");
  });

  test("the metrics sentence is the one the CLI prints, and the manifest notice is shown", async () => {
    const html = await renderRouted(<ParityBody view={two} />);
    expect(count(html, "parity-mismatch")).toBe(1);
    expect(textOf(html)).toContain("button height 40 web vs 44 android");
    expect(count(html, "parity-manifest-notice")).toBe(1);
    expect(textOf(html)).toContain("The parity manifest is kept in the repo");
  });

  test("each column links to that shot's own review page", async () => {
    const html = await renderRouted(<ParityBody view={two} />);
    expect(count(html, "parity-shot-link")).toBe(2);
    expect(html).toMatch(/href="[^"]*\/builds\/b1\/snapshots\/android-1"/);
    expect(html).toMatch(/href="[^"]*\/builds\/b1\/snapshots\/web-1"/);
  });
});

describe("the parity view with all three platforms", () => {
  const notMeasured: ParityPairView = {
    a: pairSideOf(web),
    b: pairSideOf(ios),
    status: "not_measured",
    lacks: ["ios"],
    mismatches: [],
    declared: [],
    tolerance: null,
  };
  const three = view([web, android, ios], [heightPair, notMeasured]);

  test("draws three columns, ios last, and none missing", async () => {
    const html = await renderRouted(<ParityBody view={three} />);
    expect(count(html, "parity-column")).toBe(3);
    const order = [...html.matchAll(/data-testid="parity-column"[^>]*data-platform="(\w+)"/g)];
    expect(order[2]?.[1]).toBe("ios");
    expect(count(html, "parity-missing")).toBe(0);
  });

  test("a pair with a shot that has no metrics file reads not measured, never drift", async () => {
    const html = await renderRouted(<ParityBody view={three} />);
    const pair = html.match(/data-testid="parity-pair" data-status="not_measured".*?<\/li>/s)?.[0];
    expect(textOf(pair ?? "")).toContain("not measured: no metrics file on ios");
  });
});

describe("an unlinked shot's parity view", () => {
  test("names every platform that has no shot, in the Unlinked list's words", async () => {
    const html = await renderRouted(
      <ParityBody
        view={view(
          [
            missingColumn("Button/loading", "dark", "web"),
            missingColumn("Button/loading", "dark", "android"),
            ios,
          ],
          [],
        )}
      />,
    );
    expect(count(html, "parity-missing")).toBe(2);
    expect(textOf(html)).toContain("Button/loading dark has no web twin");
    expect(textOf(html)).toContain("Only one platform has a shot here: nothing to compare.");
  });
});
