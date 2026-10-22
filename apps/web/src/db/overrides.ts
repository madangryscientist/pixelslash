import { and, desc, eq, inArray } from "drizzle-orm";
import type { SnapshotKey } from "./baselines";
import { inChunks } from "./chunks";
import type { Db } from "./db";
import { getProjectWithOrg } from "./orgs";
import { NotFoundError } from "./db";
import { isDiffKey } from "#/api/validate";
import { type DiffOptions, type OptionSource, type ResolvedDiff, snapshots, users } from "./schema";
import { diffOverrideChanges, diffOverrides } from "./schema-overrides";

/**
 * Diff options set in the review UI (ob 1495): per test (a snapshot name, every variant) or per
 * test and variant, laid over what the uploaded config asked for. The precedence is UI variant >
 * UI test > config (whose own layers, variant > route > project, the CLI merged before upload) >
 * engine default, key by key. Only the server diff reads them: a CI project's results are the
 * CLI's, measured with the config alone, so an override there would be a value nothing measured.
 *
 * Every change writes one audit row, and a project can export its overrides as config, so nothing
 * set here is only here.
 */

/** The options the review screen edits; storage takes any `DiffOptions` key. */
export const OVERRIDE_KEYS = ["threshold", "minChangedPixels", "minChangedRatio"] as const;

/** The variant part of a snapshot's key; `null` on an override for every variant of the test. */
export type VariantKey = Omit<SnapshotKey, "name">;

/** What an override is for: a test, or one variant of it. */
export type OverrideTarget = { name: string; variant: VariantKey | null };

export type Override = OverrideTarget & {
  options: DiffOptions;
  /** The GitHub login of whoever changed it last. */
  by: string;
  at: Date;
};

export type OverrideChange = OverrideTarget & {
  id: string;
  before: DiffOptions | null;
  after: DiffOptions | null;
  by: string;
  at: Date;
};

/** An override the project cannot take: a CI project's diff is the CLI's. */
export class OverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverrideError";
  }
}

export const NO_VARIANT: VariantKey = { platform: "", browser: "", viewport: "", theme: "" };

export function variantOf(row: VariantKey): VariantKey | null {
  return row.platform === "" && row.browser === "" && row.viewport === "" && row.theme === ""
    ? null
    : { platform: row.platform, browser: row.browser, viewport: row.viewport, theme: row.theme };
}

/** One canonical spelling of a set of options, so two can be compared. */
export function optionsKey(options: DiffOptions): string {
  return JSON.stringify(Object.entries(options).toSorted(([a], [b]) => a.localeCompare(b)));
}

const variantId = (v: VariantKey | null) =>
  v ? JSON.stringify([v.platform, v.browser, v.viewport, v.theme]) : "";

/** The overrides of a project, looked up by the shot they apply to. */
export type Overrides = {
  /** The options a shot is measured with, and each one's source. */
  resolve: (shot: SnapshotKey & { diffOptions: DiffOptions }) => ResolvedDiff;
};

/** Lay the test's and then the variant's override over the config's options, key by key. */
function resolveOptions(
  config: DiffOptions,
  test: Override | undefined,
  variant: Override | undefined,
): ResolvedDiff {
  const options: DiffOptions = { ...config };
  const sources: ResolvedDiff["sources"] = {};
  for (const key of Object.keys(config)) if (isDiffKey(key)) sources[key] = { from: "config" };
  for (const [layer, scope] of [
    [test, "test"],
    [variant, "variant"],
  ] as const) {
    if (!layer) continue;
    const source: OptionSource = { from: "ui", scope, by: layer.by, at: layer.at.getTime() };
    for (const [key, value] of Object.entries(layer.options)) {
      if (!isDiffKey(key) || value === undefined) continue;
      options[key] = value;
      sources[key] = source;
    }
  }
  return { options, sources };
}

function overrideOf(row: typeof diffOverrides.$inferSelect & { login: string }): Override {
  return {
    name: row.name,
    variant: variantOf(row),
    options: row.options,
    by: row.login,
    at: row.updatedAt,
  };
}

async function rowsOf(db: Db, projectId: string): Promise<Override[]> {
  const rows = await db
    .select({ row: diffOverrides, login: users.login })
    .from(diffOverrides)
    .innerJoin(users, eq(users.id, diffOverrides.updatedBy))
    .where(eq(diffOverrides.projectId, projectId));
  return rows.map(({ row, login }) => overrideOf({ ...row, login }));
}

/** The resolver the server diff measures with. Not access-checked: the diff is the server's own. */
export async function loadOverrides(db: Db, projectId: string): Promise<Overrides> {
  const byTarget = new Map<string, Override>();
  for (const o of await rowsOf(db, projectId))
    byTarget.set(JSON.stringify([o.name, variantId(o.variant)]), o);
  const at = (name: string, v: VariantKey | null) =>
    byTarget.get(JSON.stringify([name, variantId(v)]));
  return {
    resolve: (shot) =>
      resolveOptions(shot.diffOptions, at(shot.name, null), at(shot.name, variantKeyOf(shot))),
  };
}

/** A project's overrides, for a member of its org; anyone else gets `NotFoundError("project")`. */
export async function listOverrides(
  db: Db,
  userId: string,
  projectId: string,
): Promise<Override[]> {
  await getProjectWithOrg(db, userId, projectId);
  const list = await rowsOf(db, projectId);
  return list.toSorted(
    (a, b) =>
      a.name.localeCompare(b.name) || variantId(a.variant).localeCompare(variantId(b.variant)),
  );
}

/** The overrides that apply to one shot: its test's and its variant's, either absent. */
export async function shotOverrides(
  db: Db,
  userId: string,
  projectId: string,
  shot: SnapshotKey,
): Promise<{ test: Override | null; variant: Override | null }> {
  const list = await listOverrides(db, userId, projectId);
  const id = variantId(variantKeyOf(shot));
  const of = (name: string) => list.filter((o) => o.name === name);
  return {
    test: of(shot.name).find((o) => !o.variant) ?? null,
    variant: of(shot.name).find((o) => o.variant && variantId(o.variant) === id) ?? null,
  };
}

/** A shot's variant key, without its name. */
const variantKeyOf = (shot: SnapshotKey): VariantKey => ({
  platform: shot.platform,
  browser: shot.browser,
  viewport: shot.viewport,
  theme: shot.theme,
});

/**
 * What an override set from a shot's screen is for: the shot's test, or the test in the shot's
 * variant. The shot must be one of the build's (the build is the caller's, access-checked).
 */
export async function shotTarget(
  db: Db,
  buildId: string,
  snapshotId: string,
  scope: "test" | "variant",
): Promise<OverrideTarget> {
  const [shot] = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.id, snapshotId), eq(snapshots.buildId, buildId)));
  if (!shot) throw new NotFoundError("snapshot");
  return { name: shot.name, variant: scope === "variant" ? variantKeyOf(shot) : null };
}

const targetWhere = (projectId: string, t: OverrideTarget) => {
  const v = t.variant ?? NO_VARIANT;
  return and(
    eq(diffOverrides.projectId, projectId),
    eq(diffOverrides.name, t.name),
    eq(diffOverrides.platform, v.platform),
    eq(diffOverrides.browser, v.browser),
    eq(diffOverrides.viewport, v.viewport),
    eq(diffOverrides.theme, v.theme),
  );
};

/** Write the override's new value (`null` clears it) and the audit row of the change. */
async function writeOverride(
  db: Db,
  userId: string,
  { projectId, target, held, after }: Change,
): Promise<void> {
  const now = new Date();
  const variant = target.variant ?? NO_VARIANT;
  if (!after) await db.delete(diffOverrides).where(targetWhere(projectId, target));
  else if (held)
    await db
      .update(diffOverrides)
      .set({ options: after, updatedBy: userId, updatedAt: now })
      .where(eq(diffOverrides.id, held.id));
  else
    await db.insert(diffOverrides).values({
      id: crypto.randomUUID(),
      projectId,
      name: target.name,
      ...variant,
      options: after,
      updatedBy: userId,
      updatedAt: now,
    });
  await db.insert(diffOverrideChanges).values({
    id: crypto.randomUUID(),
    projectId,
    name: target.name,
    ...variant,
    before: held?.options ?? null,
    after,
    userId,
    at: now,
  });
}

type Change = {
  projectId: string;
  target: OverrideTarget;
  held: typeof diffOverrides.$inferSelect | undefined;
  after: DiffOptions | null;
};

const sameOptions = (a: DiffOptions | null, b: DiffOptions | null) =>
  (a && optionsKey(a)) === (b && optionsKey(b));

/**
 * Set a test's (or a variant's) override to `options`, replacing what it held; empty options clear
 * it, so the config's values apply again. Writes one audit row per change and none when nothing
 * changed. Returns whether anything did.
 */
export async function saveOverride(
  db: Db,
  userId: string,
  projectId: string,
  { options, ...target }: OverrideTarget & { options: DiffOptions },
): Promise<boolean> {
  const { project } = await getProjectWithOrg(db, userId, projectId);
  if (project.diffLocation === "ci")
    throw new OverrideError(
      "this project diffs in CI: the CLI measures with the config, so set this in the config",
    );
  const [held] = await db.select().from(diffOverrides).where(targetWhere(projectId, target));
  const after = Object.keys(options).length > 0 ? options : null;
  if (sameOptions(held?.options ?? null, after)) return false;
  await writeOverride(db, userId, { projectId, target, held, after });
  return true;
}

/**
 * A project's override changes, newest first, for a member of its org: every one, or those for the
 * tests named (a build page shows the changes to its own shots).
 */
export async function overrideChanges(
  db: Db,
  userId: string,
  projectId: string,
  names?: string[],
): Promise<OverrideChange[]> {
  await getProjectWithOrg(db, userId, projectId);
  if (names?.length === 0) return [];
  const read = (part?: string[]) =>
    db
      .select({ row: diffOverrideChanges, login: users.login })
      .from(diffOverrideChanges)
      .innerJoin(users, eq(users.id, diffOverrideChanges.userId))
      .where(
        and(
          eq(diffOverrideChanges.projectId, projectId),
          part ? inArray(diffOverrideChanges.name, part) : undefined,
        ),
      )
      .orderBy(desc(diffOverrideChanges.at));
  // A build's names go in parts beside the project id; the parts are merged newest first again.
  const rows = names
    ? (await inChunks(names, 1, read)).toSorted((a, b) => b.row.at.getTime() - a.row.at.getTime())
    : await read();
  return rows.map(({ row, login }) => ({
    id: row.id,
    name: row.name,
    variant: variantOf(row),
    before: row.before,
    after: row.after,
    by: login,
    at: row.at,
  }));
}
