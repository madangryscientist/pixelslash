import type { SnapshotKey } from "./baselines";
import type { Db } from "./db";
import { type IgnoreBox, listIgnoreBoxes, shotIgnoreBoxes } from "./ignore-boxes";
import {
  type Override,
  type VariantKey,
  listOverrides,
  overrideChanges,
  shotOverrides,
} from "./overrides";
import type { DiffOptions, IgnoreRect } from "./schema";

/**
 * Review-UI overrides (ob 1495) and ignore boxes (ob 1499) as config, so nothing set in the UI is
 * only there: a snippet per override or box, the project's whole export, and the payloads the
 * settings and snapshot pages read.
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

type VariantLayer = { diff?: DiffOptions; ignore?: IgnoreRect[] };

type Route = {
  name: string;
  diff?: DiffOptions;
  ignore?: IgnoreRect[];
  variants?: Record<string, VariantLayer>;
};

/** A `pixelslash.config.json` fragment: the variants the overrides name, and a route per test. */
export type ConfigExport = { variants?: ConfigVariant[]; routes: Route[] };

function configVariant(v: VariantKey): ConfigVariant {
  const [width = 0, height = 0] = v.viewport.split("x").map(Number);
  return { name: variantName(v), browser: v.browser, viewport: { width, height }, theme: v.theme };
}

/**
 * The overrides and boxes as config: merge each route's `diff`, `ignore` and `variants` into the
 * route (or story) of that name. A variant is named by the config's default
 * (`chromium-1280x720-light`); one the config already names differently is renamed to match.
 * Uploaded with no overrides, it measures as they do — except where the config already sets the
 * same key on that variant, which beats a route's value: move it to the variant, or drop the
 * config's. A box is in image px, and a config rect in CSS px: the same at a deviceScaleFactor of 1.
 */
export function exportOverrides(list: Override[], boxes: IgnoreBox[] = []): ConfigExport {
  const routes = new Map<string, Route>();
  const variants = new Map<string, ConfigVariant>();
  const routeOf = (name: string) => {
    const route = routes.get(name) ?? { name };
    routes.set(name, route);
    return route;
  };
  const variantOf = (route: Route, key: VariantKey): VariantLayer => {
    const v = configVariant(key);
    variants.set(v.name, v);
    route.variants ??= {};
    return (route.variants[v.name] ??= {});
  };
  for (const o of list) {
    const route = routeOf(o.name);
    if (o.variant) variantOf(route, o.variant).diff = { ...o.options };
    else route.diff = { ...o.options };
  }
  for (const b of boxes.toSorted((x, y) => x.at.getTime() - y.at.getTime())) {
    const route = routeOf(b.name);
    const layer = b.variant ? variantOf(route, b.variant) : route;
    layer.ignore = [...(layer.ignore ?? []), { ...b.rect }];
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

/** One box as the config snippet its row offers to copy: the route with the rect under `ignore`. */
export function boxSnippet(b: Pick<IgnoreBox, "name" | "variant" | "rect">): string {
  const route: Record<string, unknown> = { name: b.name };
  if (b.variant) route.variants = { [variantName(b.variant)]: { ignore: [b.rect] } };
  else route.ignore = [b.rect];
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

/** The review-UI ignore boxes on one shot's test and variant, for a member of its org. */
export async function snapshotIgnoreBoxes(
  db: Db,
  userId: string,
  projectId: string,
  shot: SnapshotKey,
) {
  const boxes = await shotIgnoreBoxes(db, userId, projectId, shot);
  return boxes.map((b) => ({ ...b, snippet: boxSnippet(b) }));
}

/**
 * A project's overrides and ignore boxes for its settings page: each with its snippet, the trails,
 * and one export of both.
 */
export async function settingsOverrides(db: Db, userId: string, projectId: string) {
  const list = await listOverrides(db, userId, projectId);
  const boxes = await listIgnoreBoxes(db, userId, projectId);
  return {
    list: list.map((o) => ({ ...o, snippet: overrideSnippet(o) })),
    changes: await overrideChanges(db, userId, projectId),
    boxes: boxes.active.map((b) => ({ ...b, snippet: boxSnippet(b) })),
    boxTrail: boxes.trail,
    exported: JSON.stringify(exportOverrides(list, boxes.active), null, 2),
  };
}
