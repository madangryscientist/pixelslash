import { describe, expect, test, vi } from "vitest";
import type { SnapshotView } from "#/db/review";
import type { DiffResult } from "#/db/schema";
import type { StaleItem } from "#/lib/stale";
import { renderRouted, textOf } from "#/test/render-routed";
import { snapshotView } from "#/test/snapshot-view";
import { toReviewText } from "./build-header";
import { measured } from "./shot-card";
import { StaleBadge, StaleList } from "./stale";

// `flake` reaches a server function, and with it the Worker's bindings, which Node does not have;
// the line under test never draws a flake badge.
vi.mock("#/components/flake", () => ({ FlakyBadge: () => null }));

/**
 * A stale native twin as the screens say it: the project page's list, the badge, and the line on
 * the native shot itself. When a key goes stale and when it clears is `db/stale.test.ts`.
 */

const item = (over: Partial<StaleItem> = {}): StaleItem => ({
  name: "Button/md-primary",
  theme: "dark",
  platform: "android",
  cause: {
    snapshotId: "web-9",
    buildId: "0123456789abcdef",
    projectId: "p1",
    projectName: "stale",
    acceptedBy: "E2E Octocat",
    acceptedAt: new Date("2026-11-03T10:00:00Z"),
  },
  shots: [
    {
      snapshotId: "android-1",
      buildId: "b2",
      projectId: "p1",
      device: "Pixel 8 API 35",
      viewport: "412x915",
    },
  ],
  ...over,
});

const count = (html: string, testId: string) => html.split(`data-testid="${testId}"`).length - 1;

describe("the project page's Stale list", () => {
  test("says which twin is stale, which build changed it, and who accepted it", async () => {
    const html = await renderRouted(<StaleList items={[item()]} />);
    expect(count(html, "stale-item")).toBe(1);
    // Tags dropped with no space left, so the link reads as part of the sentence it sits in.
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "Button/md-primary dark on android is stale: web changed in build 01234567, accepted by E2E Octocat 2026-11-03",
    );
  });

  test("the cause is a link to the build's web shot, named by the first eight characters", async () => {
    const html = await renderRouted(<StaleList items={[item()]} />);
    const cause = html.match(/<a [^>]*data-testid="stale-cause"[^>]*>([^<]*)</);
    expect(cause?.[1]).toBe("01234567");
    expect(cause?.[0]).toMatch(/href="[^"]*\/builds\/0123456789abcdef\/snapshots\/web-9"/);
  });

  test("offers the native shot a reviewer accepts", async () => {
    const html = await renderRouted(<StaleList items={[item()]} />);
    expect(textOf(html)).toContain("Review the android shot");
    expect(html).toMatch(/href="[^"]*\/builds\/b2\/snapshots\/android-1"/);
  });

  test("several devices and sizes of one key are one line that says so", async () => {
    const shot = item().shots[0];
    if (!shot) throw new Error("fixture has a shot");
    const two = item({ shots: [shot, { ...shot, snapshotId: "android-2", viewport: "800x1280" }] });
    const html = await renderRouted(<StaleList items={[two]} />);
    expect(count(html, "stale-item")).toBe(1);
    expect(textOf(html)).toContain("2 devices and sizes");
  });

  test("a project with nothing stale draws no list", async () => {
    const html = await renderRouted(<StaleList items={[]} />);
    expect(html).not.toContain("stale-item");
    expect(textOf(html)).not.toContain("Stale");
  });
});

describe("the Stale badge", () => {
  test("is the one marker, worded Stale", async () => {
    const html = await renderRouted(<StaleBadge />);
    expect(count(html, "stale-badge")).toBe(1);
    expect(textOf(html)).toBe("Stale");
  });
});

const result: DiffResult = {
  changedPixels: 0,
  antialiasedPixels: 0,
  ignoredPixels: 0,
  ignored: [],
  specks: { count: 0, pixels: 0 },
  regions: [],
  width: 412,
  height: 915,
  mainWidth: 412,
  mainHeight: 915,
  branchWidth: 412,
  branchHeight: 915,
  sizeChanged: false,
};

/** An unchanged, undecided android shot: the fields the line and the group read, the rest empty. */
const nativeShot = (over: Partial<SnapshotView> = {}): SnapshotView =>
  snapshotView({
    id: "android-1",
    name: "Button/md-primary",
    platform: "android",
    browser: "Pixel 8 API 35",
    scale: 2.625,
    viewport: "412x915",
    theme: "dark",
    tags: ["native"],
    diffStatus: "unchanged",
    imageKey: "android-1.png",
    diffResult: result,
    staleOf: "web-9",
    ...over,
  });

describe("the line on a stale native shot", () => {
  test("an unchanged shot of a stale key says nothing differs here and why it still needs a review", () => {
    expect(measured(nativeShot(), false)).toBe(
      "no change here; the web twin changed, so this native shot needs a review",
    );
  });

  test("once a person accepted it, it says plain no change", () => {
    expect(measured(nativeShot({ reviewState: "accepted" }), false)).toBe("no change");
  });

  test("an unchanged shot of a fresh key says plain no change", () => {
    expect(measured(nativeShot({ staleOf: null }), false)).toBe("no change");
  });
});

describe("the build header's count", () => {
  test("one shot waiting is worded 1 to review, none is worded nothing to review", () => {
    expect(toReviewText(false, 1)).toBe("1 to review");
    expect(toReviewText(false, 0)).toBe("nothing to review");
    expect(toReviewText(true, 3)).toBe("baseline set");
  });
});
