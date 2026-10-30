import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { builds, snapshots } from "#/db/schema";
import { buildView } from "#/db/review";
import { MAX_VIOLATIONS } from "@pixelslash/engine/a11y-entry";
import { META, call, openBuild, setup, snapshotForm } from "./test-support";

const CONTRAST = {
  rule: "color-contrast",
  impact: "serious",
  help: "Elements must meet minimum color contrast ratio thresholds",
  selector: "#hint",
};
const LABEL = {
  rule: "label",
  impact: "critical",
  help: "Form elements must have labels",
  selector: "#email",
};

describe("a shot's accessibility scan (PS-238)", () => {
  test("is stored as sent; a shot that was not scanned stores null, a clean scan stores an empty list", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const path = `PUT /api/v1/builds/${id}/snapshots`;
    const scans = {
      pricing: { violations: [CONTRAST, LABEL] },
      clean: { violations: [] },
    };
    for (const [name, a11y] of Object.entries(scans))
      expect(
        (await call(deps, path, acme.token, snapshotForm({ ...META, name, a11y }))).status,
      ).toBe(200);
    expect(
      (await call(deps, path, acme.token, snapshotForm({ ...META, name: "plain" }))).status,
    ).toBe(200);
    const rows = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    const by = new Map(rows.map((r) => [r.name, r.a11y]));
    expect(by.get("pricing")).toEqual(scans.pricing);
    expect(by.get("clean")).toEqual(scans.clean);
    expect(by.get("plain")).toBeNull();
  });

  test("a malformed or oversized scan is a 400 naming the field, and nothing is stored", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const path = `PUT /api/v1/builds/${id}/snapshots`;
    const many = Array.from({ length: MAX_VIOLATIONS + 1 }, () => CONTRAST);
    for (const [a11y, message] of [
      [{ violations: [{ ...CONTRAST, impact: "huge" }] }, "a11y.violations[0].impact"],
      [{ violations: many }, `at most ${MAX_VIOLATIONS}`],
      [{ violations: [{ ...CONTRAST, selector: "" }] }, "a11y.violations[0].selector"],
      ["yes", "a11y"],
    ] as const) {
      const res = await call(deps, path, acme.token, snapshotForm({ ...META, a11y }));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(message);
    }
    expect(await db.select().from(snapshots)).toHaveLength(0);
  });
});

async function twoBuilds(baseline: unknown, branch: unknown) {
  const { db, deps, acme } = await setup();
  const send = async (buildId: string, a11y: unknown) => {
    const meta = a11y === undefined ? META : { ...META, a11y };
    const res = await call(
      deps,
      `PUT /api/v1/builds/${buildId}/snapshots`,
      acme.token,
      snapshotForm(meta),
    );
    expect(res.status).toBe(200);
  };
  const first = await openBuild(deps, acme.token);
  await send(first, baseline);
  const [base] = await db.select().from(snapshots).where(eq(snapshots.buildId, first));
  const second = await openBuild(deps, acme.token);
  await send(second, branch);
  // The server picks the baseline when it measures; here the link is set by hand.
  await db
    .update(snapshots)
    .set({ baselineSnapshotId: base?.id ?? null })
    .where(eq(snapshots.buildId, second));
  const [build] = await db.select().from(builds).where(eq(builds.id, second));
  if (!build) throw new Error("no build");
  const view = await buildView(db, build.projectId, second);
  return view.snapshots[0]?.a11yDiff;
}

describe("the review view splits a scan into new and already there", () => {
  test("new on Branch against the baseline's scan", async () => {
    expect(await twoBuilds({ violations: [CONTRAST] }, { violations: [CONTRAST, LABEL] })).toEqual({
      state: "compared",
      fresh: [LABEL],
      already: [CONTRAST],
      omitted: 0,
    });
  });

  test("nothing new when the baseline has the same violations", async () => {
    const both = { violations: [CONTRAST, LABEL] };
    expect(await twoBuilds(both, both)).toEqual({
      state: "compared",
      fresh: [],
      already: [CONTRAST, LABEL],
      omitted: 0,
    });
  });

  test("a baseline that was not scanned calls nothing new", async () => {
    expect(await twoBuilds(undefined, { violations: [CONTRAST] })).toEqual({
      state: "unbaselined",
      found: [CONTRAST],
      omitted: 0,
    });
  });

  test("a shot that was not scanned claims nothing", async () => {
    expect(await twoBuilds({ violations: [CONTRAST] }, undefined)).toEqual({ state: "off" });
  });
});
