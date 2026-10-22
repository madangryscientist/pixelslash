import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Fail } from "./diff-options.ts";

/**
 * What a feature in `pixelslash dev` is being built against (ob 1741): `features.<target>` names a
 * markdown spec and reference images, each a repo PNG or a Figma frame, optionally tied to one
 * viewport or theme. PixelSlash reads the spec and the PNGs; it never writes them.
 */

type RefTie = {
  /** `WxH` or a variant name; unset is every viewport. */
  viewport?: string | undefined;
  theme?: "light" | "dark" | undefined;
};

export type FeatureRef = RefTie &
  ({ kind: "png"; path: string } | { kind: "figma"; url: string; fileKey: string; nodeId: string });

export type Feature = {
  /** A markdown file saying what is being built; resolved against the config's dir on load. */
  spec: string | undefined;
  refs: FeatureRef[];
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A Figma frame URL: the file key, and the frame's `node-id` (`1-2` in the URL, `1:2` in the API). */
export function parseFigmaUrl(raw: string): { fileKey: string; nodeId: string } | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || !/^(www\.)?figma\.com$/.test(u.hostname)) return undefined;
  const key = /^\/(?:file|design|proto)\/([A-Za-z0-9]+)(?:\/|$)/.exec(u.pathname)?.[1];
  const node = u.searchParams.get("node-id");
  if (!key || !node || !/^\d+[-:]\d+$/.test(node)) return undefined;
  return { fileKey: key, nodeId: node.replace("-", ":") };
}

function tie(v: Record<string, unknown>, where: string, variants: string[], fail: Fail): RefTie {
  const out: RefTie = {};
  if (v.viewport !== undefined) {
    const vp = v.viewport;
    if (typeof vp !== "string" || !(/^\d+x\d+$/.test(vp) || variants.includes(vp)))
      fail(`${where}.viewport`, `must be WxH or a variant name (have ${variants.join(", ")})`);
    out.viewport = vp;
  }
  if (v.theme !== undefined) {
    if (v.theme !== "light" && v.theme !== "dark")
      fail(`${where}.theme`, 'must be "light" or "dark"');
    out.theme = v.theme;
  }
  return out;
}

const REF_SHAPE = "must be a PNG path, a Figma frame URL, or { src, viewport?, theme? }";

/** Fail on a key that is not one of `allowed`, naming the key's path. */
function onlyKeys(v: Record<string, unknown>, allowed: string[], where: string, fail: Fail) {
  const what = allowed.includes("src") ? "ref" : "feature";
  for (const k of Object.keys(v))
    if (!allowed.includes(k))
      fail(`${where}.${k}`, `is not a ${what} option (${allowed.join(", ")})`);
}

function source(src: string, where: string, fail: Fail): FeatureRef {
  if (/^https?:/i.test(src)) {
    const figma = parseFigmaUrl(src);
    if (!figma)
      fail(`${where}.src`, `is not a Figma frame URL (https://figma.com/design/KEY/…?node-id=1-2)`);
    return { kind: "figma", url: src, ...figma };
  }
  if (!src.toLowerCase().endsWith(".png")) fail(`${where}.src`, "must be a .png path");
  return { kind: "png", path: src };
}

function ref(v: unknown, where: string, variants: string[], fail: Fail): FeatureRef {
  const r = typeof v === "string" ? { src: v } : v;
  if (!isObj(r)) fail(where, REF_SHAPE);
  onlyKeys(r, ["src", "viewport", "theme"], where, fail);
  if (typeof r.src !== "string" || r.src === "") fail(`${where}.src`, REF_SHAPE);
  return { ...source(r.src, where, fail), ...tie(r, where, variants, fail) };
}

function feature(v: unknown, where: string, variants: string[], fail: Fail): Feature {
  if (!isObj(v)) fail(where, "must be { spec?, refs? }");
  onlyKeys(v, ["spec", "refs"], where, fail);
  const spec = v.spec;
  if (spec !== undefined && (typeof spec !== "string" || !spec.toLowerCase().endsWith(".md")))
    fail(`${where}.spec`, "must be a path to a markdown (.md) file");
  if (v.refs !== undefined && !Array.isArray(v.refs)) fail(`${where}.refs`, "must be an array");
  const refs = (v.refs ?? []).map((r, i) => ref(r, `${where}.refs[${i}]`, variants, fail));
  return { spec, refs };
}

/** The config's `features`, keyed by route or story name. */
export function parseFeatures(v: unknown, variants: string[], fail: Fail): Record<string, Feature> {
  if (v === undefined) return {};
  if (!isObj(v)) fail("features", "must be an object keyed by route or story name");
  const out: Record<string, Feature> = {};
  for (const [name, f] of Object.entries(v))
    out[name] = feature(f, `features.${name}`, variants, fail);
  return out;
}

/** The features with their spec and PNG paths made absolute against `dir` (the config's). */
export function featuresBeside(
  features: Record<string, Feature>,
  dir: string,
): Record<string, Feature> {
  const out: Record<string, Feature> = {};
  for (const [name, f] of Object.entries(features))
    out[name] = {
      spec: f.spec === undefined ? undefined : resolve(dir, f.spec),
      refs: f.refs.map((r) => (r.kind === "png" ? { ...r, path: resolve(dir, r.path) } : r)),
    };
  return out;
}

/**
 * Each spec and PNG ref is there, so a typo fails when `dev` loads the config, naming the key and
 * the file it looked for. Only `dev` reads them, so `capture` and `check` never call this: a ref
 * that lives only on a designer's machine must not fail CI.
 */
export function checkFeatureFiles(features: Record<string, Feature>, fail: Fail): void {
  const found = (where: string, path: string) => {
    if (!existsSync(path)) fail(where, `names ${path}, which does not exist`);
  };
  for (const [name, f] of Object.entries(features)) {
    if (f.spec !== undefined) found(`features.${name}.spec`, f.spec);
    f.refs.forEach((r, i) => {
      if (r.kind === "png") found(`features.${name}.refs[${i}].src`, r.path);
    });
  }
}
