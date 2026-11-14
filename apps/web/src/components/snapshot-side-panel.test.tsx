import { describe, expect, test } from "vitest";
import { buildView } from "#/db/review";
import { context, FINGERPRINT, sha, upload, type Shot } from "#/diff/test-builds";
import { shot } from "#/diff/test-shots";
import { renderRouted, textOf } from "#/test/render-routed";
import { snapshotView } from "#/test/snapshot-view";
import { SidePanel } from "./snapshot-side-panel";

/** The "Captured in" panel of a shot's review page, for a web shot and for a native one. */

const png = shot({ width: 120, height: 240 });

const android: Shot = {
  name: "login",
  png,
  renderer: { platform: "android", browser: "Pixel 8 API 35" },
  fingerprint: { ...FINGERPRINT, platform: "android", device: "Pixel 8 API 35", scale: "3" },
};

async function panelOf(shotSpec: Shot, platform: string): Promise<string> {
  const ctx = await context();
  const build = await upload(ctx, { branch: "main", commit: sha(1), shots: [shotSpec] });
  const view = await buildView(ctx.db, ctx.projectId, build.id);
  const snapshot = view.snapshots.find((s) => s.platform === platform);
  if (!snapshot) throw new Error(`no ${platform} shot`);
  const html = await renderRouted(
    <SidePanel
      projectId={ctx.projectId}
      buildId={build.id}
      snapshot={snapshot}
      options={{}}
      reviewable
      status={build.status}
    />,
  );
  return /Captured in[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

describe("Captured in", () => {
  test("a native shot names its platform, its device and the scale, and no browser", async () => {
    const text = textOf(await panelOf(android, "android"));
    expect(text).toContain("Platform android");
    expect(text).toContain("Device Pixel 8 API 35");
    expect(text.replace(/\s+×/, "×")).toContain("Scale 3×");
    expect(text).not.toContain("Browser");
  });

  test("a web shot names its browser and has no device or scale", async () => {
    const text = textOf(await panelOf({ png }, "linux"));
    expect(text).toContain("Platform linux");
    expect(text).toContain("Browser chromium");
    expect(text).not.toContain("Device");
    expect(text).not.toContain("Scale");
  });
});

const approvedText = async (mainChangedSince: boolean) => {
  const html = await renderRouted(
    <SidePanel
      projectId="p1"
      buildId="b1"
      snapshot={snapshotView({
        diffStatus: "unchanged",
        reviewState: "accepted",
        approvedEarlier: {
          snapshotId: "s0",
          buildId: "b0",
          commitSha: "61f0c17000000000000000000000000000000000",
          reviewedBy: "ada",
          reviewedAt: new Date(0),
          defaultBranch: "main",
          mainChangedSince,
        },
      })}
      options={{}}
      reviewable
      status="passed"
    />,
  );
  return textOf(/data-testid="approved-earlier"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "");
};

describe("Approved earlier", () => {
  test("says main has changed since that approval when it has", async () => {
    expect(await approvedText(true)).toContain(
      "main has changed since that approval, so it was given against an older main",
    );
  });

  test("says nothing about main moving when it has not", async () => {
    const text = await approvedText(false);
    expect(text).toContain("this shot still differs from main");
    expect(text).not.toContain("has changed since that approval");
  });
});
