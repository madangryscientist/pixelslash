import type { SnapshotKey } from "./baselines";
import type { Db } from "./db";
import {
  type Override,
  type VariantKey,
  listOverrides,
  overrideChanges,
  shotOverrides,
} from "./overrides";
import type { DiffOptions } from "./schema";

/**
 * Review-UI overrides as config (ob 1495), so nothing set in the UI is only there: a snippet per
 * override, the project's whole export, and the payloads the settings and snapshot pages read.
 */

/** The config's default name for a variant, which `parseConfig` gives one that names none. */
function variantName(v: VariantKey): string {
  return `${v.browser}-${v.viewport}-${v.theme}`;
}

type ConfigVariant = {
  name: string;
  browser: string;
  viewport: { width: number; height: number };
  theme: string;
};

/** A `pixelslash.config.json` fragment: the variants the overrides name, and a route per test. */
export type ConfigExport = {
  variants?: ConfigVariant[];
  routes: { name: string; diff?: DiffOptions; variants?: Record<string, { diff: DiffOptions }> }[];
};

function configVariant(v: VariantKey): ConfigVariant {
  const [width = 0, height = 0] = v.viewport.split("x").map(Number);
  return { name: variantName(v), browser: v.browser, viewport: { width, height }, theme: v.theme };
}

/**
 * The overrides as config: merge each route's `diff` and `variants` into the route (or story) of
 * that name. A variant is named by the config's default (`chromium-1280x720-light`); one the
 * config already names differently is renamed to match. Uploaded with no overrides, it measures
 * as they do — except where the config already sets the same key on that variant, which beats a
 * route's value: move it to the variant, or drop the config's.
 */
export function exportOverrides(list: Override[]): ConfigExport {
  const routes = new Map<string, ConfigExport["routes"][number]>();
  const variants = new Map<string, ConfigVariant>();
  for (const o of list) {
    const route = routes.get(o.name) ?? { name: o.name };
    routes.set(o.name, route);
    if (!o.variant) {
      route.diff = { ...o.options };
      continue;
    }
    const v = configVariant(o.variant);
    variants.set(v.name, v);
    route.variants = { ...route.variants, [v.name]: { diff: { ...o.options } } };
  }
  const out: ConfigExport = { routes: [...routes.values()] };
  if (variants.size > 0) out.variants = [...variants.values()];
  return out;
}

/** One override as the config snippet the review screen offers to copy. */
export function overrideSnippet(o: Pick<Override, "name" | "variant" | "options">): string {
  const route: Record<string, unknown> = { name: o.name };
  if (o.variant) route.variants = { [variantName(o.variant)]: { diff: o.options } };
  else route.diff = o.options;
  return JSON.stringify(route, null, 2);
}

const withSnippet = <T extends Override>(o: T | null) => o && { ...o, snippet: overrideSnippet(o) };

/** The overrides on one shot's test and variant, for a member of its org, each with its snippet. */
export async function snapshotOverrides(
  db: Db,
  userId: string,
  projectId: string,
  shot: SnapshotKey,
) {
  const { test, variant } = await shotOverrides(db, userId, projectId, shot);
  return { test: withSnippet(test), variant: withSnippet(variant) };
}

/** A project's overrides for its settings page: each with its snippet, the trail, the export. */
export async function settingsOverrides(db: Db, userId: string, projectId: string) {
  const list = await listOverrides(db, userId, projectId);
  return {
    list: list.map((o) => ({ ...o, snippet: overrideSnippet(o) })),
    changes: await overrideChanges(db, userId, projectId),
    exported: JSON.stringify(exportOverrides(list), null, 2),
  };
}
