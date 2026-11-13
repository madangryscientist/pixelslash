import { describe, expect, test } from "vitest";
import { renderRouted, textOf } from "#/test/render-routed";
import { type BuildTwins, type Twin, type TwinEntry, noTwins, twinEntryOf } from "#/lib/twins";
import { TwinsRow, UnlinkedShots } from "./twins";

/**
 * The Twins row of a shot's side panel and the build page's Unlinked list: what each names, how
 * many rows it draws, and where its links go. Which shots are twins is `db/twins.test.ts`.
 */

const android: Twin = {
  snapshotId: "android-1",
  platform: "android",
  device: "Pixel 8 API 35",
  viewport: "412x915",
  projectId: "p1",
  projectName: "app",
  buildId: "b1",
  source: { kind: "build", commitSha: null },
  hasMetrics: false,
  stale: null,
};

const entry = (over: Partial<TwinEntry> = {}): TwinEntry => ({
  snapshotId: "web-1",
  name: "Button/primary",
  theme: "dark",
  platform: "web",
  device: null,
  viewport: "1280x720",
  hasMetrics: false,
  stale: null,
  twins: [android],
  missing: [],
  ...over,
});

const unlinkedEntry = entry({
  snapshotId: "android-2",
  name: "Button/loading",
  platform: "android",
  device: "Pixel 8 API 35",
  twins: [],
  missing: ["web"],
});

const count = (html: string, testId: string) => html.split(`data-testid="${testId}"`).length - 1;

describe("the Twins row of the side panel", () => {
  test("lists the twin labelled by platform and device, with where it was found", async () => {
    const html = await renderRouted(<TwinsRow projectId="p1" buildId="b1" entry={entry()} />);
    expect(count(html, "twins")).toBe(1);
    expect(count(html, "twin")).toBe(1);
    const text = textOf(html);
    expect(text).toContain("android · Pixel 8 API 35");
    expect(text).toContain("412x915 · same build");
    expect(text).toContain("Compare platforms");
  });

  test("the twin is a link to its own shot", async () => {
    const html = await renderRouted(<TwinsRow projectId="p1" buildId="b1" entry={entry()} />);
    expect(html).toMatch(/<a [^>]*href="[^"]*\/projects\/p1\/builds\/b1\/snapshots\/android-1"/);
  });

  test("the android shot's row links back to the web shot", async () => {
    const back: Twin = {
      ...android,
      snapshotId: "web-1",
      platform: "web",
      device: null,
      viewport: "1280x720",
    };
    const html = await renderRouted(
      <TwinsRow
        projectId="p1"
        buildId="b1"
        entry={entry({ snapshotId: "android-1", platform: "android", twins: [back] })}
      />,
    );
    expect(count(html, "twin")).toBe(1);
    expect(textOf(html)).toContain("web 1280x720 · same build");
    expect(html).toMatch(/href="[^"]*\/snapshots\/web-1"/);
  });

  test("a platform with no shot under the key is named, not hidden", async () => {
    const html = await renderRouted(
      <TwinsRow projectId="p1" buildId="b1" entry={entry({ missing: ["ios"] })} />,
    );
    expect(textOf(html)).toContain("No ios twin");
    expect(count(html, "twin-missing")).toBe(1);
  });

  test("a stale twin carries the badge and who accepted the web change", async () => {
    const stale = {
      snapshotId: "web-9",
      buildId: "b9",
      projectId: "p1",
      projectName: "app",
      acceptedBy: "E2E Octocat",
      acceptedAt: new Date("2026-11-03T10:00:00Z"),
    };
    const html = await renderRouted(
      <TwinsRow projectId="p1" buildId="b1" entry={entry({ twins: [{ ...android, stale }] })} />,
    );
    expect(count(html, "stale-badge")).toBe(1);
    expect(count(html, "twin-stale-cause")).toBe(1);
    expect(textOf(html)).toContain("web changed, accepted by E2E Octocat 2026-11-03");
  });

  test("a fresh twin carries no badge", async () => {
    const html = await renderRouted(<TwinsRow projectId="p1" buildId="b1" entry={entry()} />);
    expect(count(html, "stale-badge")).toBe(0);
  });

  test("a build with no other platform in play has no row and no Compare platforms link", async () => {
    const none = noTwins();
    expect(twinEntryOf(none, "web-1")).toBeNull();
    const html = await renderRouted(
      <TwinsRow projectId="p1" buildId="b1" entry={twinEntryOf(none, "web-1")} />,
    );
    expect(html).not.toContain("compare-platforms");
    expect(html).not.toContain('data-testid="twins"');
  });
});

describe("the Unlinked list of the build page", () => {
  const twins: BuildTwins = { twinProject: null, linked: [entry()], unlinked: [unlinkedEntry] };

  test("names the shot that has no twin, and only that one", async () => {
    const html = await renderRouted(<UnlinkedShots projectId="p1" buildId="b1" twins={twins} />);
    expect(count(html, "unlinked")).toBe(1);
    expect(count(html, "unlinked-shot")).toBe(1);
    expect(textOf(html)).toContain("Button/loading dark has no web twin");
    expect(textOf(html)).not.toContain("Button/primary");
  });

  test("each unlinked shot opens the shot and the parity view of its key", async () => {
    const html = await renderRouted(<UnlinkedShots projectId="p1" buildId="b1" twins={twins} />);
    expect(html).toMatch(/href="[^"]*\/snapshots\/android-2"/);
    const compare = html.match(/<a [^>]*data-testid="compare-platforms"[^>]*>/)?.[0] ?? "";
    expect(compare).toMatch(/href="[^"]*\/parity\?/);
    expect(decodeURIComponent(compare)).toContain("name");
    expect(decodeURIComponent(compare)).toContain("Button/loading");
  });

  test("a web-only build has no Unlinked list and no Compare platforms link", async () => {
    const html = await renderRouted(
      <UnlinkedShots projectId="p1" buildId="b1" twins={noTwins()} />,
    );
    expect(html).not.toContain("compare-platforms");
    expect(html).not.toContain('data-testid="unlinked"');
  });

  test("nothing is drawn when every shot is linked", async () => {
    const html = await renderRouted(
      <UnlinkedShots
        projectId="p1"
        buildId="b1"
        twins={{ twinProject: null, linked: [entry()], unlinked: [] }}
      />,
    );
    expect(html).not.toContain("unlinked");
  });
});
