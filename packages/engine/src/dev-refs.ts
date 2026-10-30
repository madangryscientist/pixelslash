import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Feature, FeatureRef, Variant } from "./config.ts";
import type { DevIteration, DevStore } from "./dev-store.ts";
import { type FetchLike, fetchFigmaFrame } from "./figma.ts";

/**
 * A `pixelslash dev` feature's spec and references, resolved (ob 1741). A ref is expanded to one
 * entry per variant it applies to; a Figma frame is rendered at that variant's width times the
 * device scale factor and cached in `.pixelslash/dev/refs/`, re-fetched only when asked (`f`,
 * `--refresh-refs`). Nothing here measures a shot against a reference: a mock-up is not a baseline.
 */

export type Size = { width: number; height: number };

export type DevRef = {
  /** Its place in the resolved list; the live page serves it at `/ref/<index>`. */
  index: number;
  kind: "png" | "figma";
  /** The repo path or the Figma URL, as the config gave it (the path made absolute). */
  source: string;
  variant: string;
  /** `WxH` of the variant. */
  viewport: string;
  theme: "light" | "dark";
  file: string | null;
  size: Size | null;
  /** The file's mtime: it changes on a refetch, so the live page reloads the image. */
  modified: number | null;
  /** Why there is no file: `no figma token`, or the Figma error. */
  skip: string | null;
};

export type DevSpec = { path: string; text: string };

export type DevFeature = { spec: DevSpec | null; refs: DevRef[] };

export type FigmaSource = { token: string | undefined; fetch: FetchLike };

export const refsDir = (store: DevStore) => join(store.root, "refs");

/** A PNG's size from its header, without decoding it; null when it is not a PNG. */
export async function pngSize(file: string): Promise<Size | null> {
  const head = new Uint8Array(await Bun.file(file).slice(0, 24).arrayBuffer());
  if (head.length < 24 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) return null;
  const view = new DataView(head.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const viewportOf = (v: Variant) => `${v.viewport.width}x${v.viewport.height}`;

function applies(ref: FeatureRef, v: Variant): boolean {
  if (ref.viewport !== undefined && ref.viewport !== viewportOf(v) && ref.viewport !== v.name)
    return false;
  return ref.theme === undefined || ref.theme === v.theme;
}

type Resolve = {
  store: DevStore;
  variants: Variant[];
  dpr: number;
  figma: FigmaSource;
  refresh: boolean;
  /** Cache files fetched in this pass, so two variants of one width fetch once. */
  fetched: Set<string>;
};

async function figmaFile(
  ref: Extract<FeatureRef, { kind: "figma" }>,
  width: number,
  r: Resolve,
): Promise<{ file: string | null; skip: string | null }> {
  const hash = createHash("sha256").update(`${ref.url}\n${width}`).digest("hex").slice(0, 16);
  const file = join(refsDir(r.store), `figma-${hash}.png`);
  const cached = r.fetched.has(file) || (!r.refresh && (await Bun.file(file).exists()));
  if (cached) return { file, skip: null };
  if (!r.figma.token) {
    // An earlier render still stands in when a refresh has no token to fetch with.
    if (await Bun.file(file).exists()) return { file, skip: null };
    return { file: null, skip: "no figma token" };
  }
  try {
    const png = await fetchFigmaFrame({
      ...ref,
      token: r.figma.token,
      width,
      fetch: r.figma.fetch,
    });
    await mkdir(refsDir(r.store), { recursive: true });
    await Bun.write(file, png);
    r.fetched.add(file);
    return { file, skip: null };
  } catch (e) {
    return { file: null, skip: `figma failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function oneRef(ref: FeatureRef, v: Variant, index: number, r: Resolve): Promise<DevRef> {
  const got =
    ref.kind === "png"
      ? { file: ref.path, skip: null }
      : await figmaFile(ref, v.viewport.width * r.dpr, r);
  return {
    index,
    kind: ref.kind,
    source: ref.kind === "png" ? ref.path : ref.url,
    variant: v.name,
    viewport: viewportOf(v),
    theme: v.theme,
    file: got.file,
    size: got.file ? await pngSize(got.file) : null,
    modified: got.file ? Bun.file(got.file).lastModified : null,
    skip: got.skip,
  };
}

/** The spec's text, read fresh (it is edited while `dev` runs); null when the target has none. */
export async function readSpec(feature: Feature | undefined): Promise<DevSpec | null> {
  if (!feature?.spec) return null;
  return { path: feature.spec, text: await Bun.file(feature.spec).text() };
}

/** Every ref of `feature` per variant it applies to, with its file or why it has none. */
export async function resolveRefs(
  feature: Feature | undefined,
  opts: Omit<Resolve, "fetched">,
): Promise<DevRef[]> {
  const r: Resolve = { ...opts, fetched: new Set() };
  const out: DevRef[] = [];
  for (const ref of feature?.refs ?? [])
    for (const v of opts.variants)
      if (applies(ref, v)) out.push(await oneRef(ref, v, out.length, r));
  return out;
}

/** A shot of the latest iteration and the reference it is shown beside (null: the spec alone). */
export type FeaturePair = {
  name: string;
  shot: string;
  variant: string;
  file: string;
  size: Size;
  ref: DevRef | null;
  /** Both sizes, and when they differ, that the overlay is only the overlapping rectangle. */
  sizes: string | null;
  overlap: Size | null;
};

const wxh = (s: Size) => `${s.width}×${s.height}`;

function sizesOf(shot: Size, ref: Size): { sizes: string; overlap: Size } {
  const overlap = {
    width: Math.min(shot.width, ref.width),
    height: Math.min(shot.height, ref.height),
  };
  const same = shot.width === ref.width && shot.height === ref.height;
  const tail = same
    ? ""
    : ` · sizes differ: the overlay shows only the overlapping ${wxh(overlap)} from the top left`;
  return { sizes: `reference ${wxh(ref)} · now ${wxh(shot)}${tail}`, overlap };
}

/** Each shot of `it` beside each ready ref of its variant; a shot with none gets the spec alone. */
export function featurePairs(it: DevIteration, feature: DevFeature): FeaturePair[] {
  const pairs: FeaturePair[] = [];
  for (const s of it.shots) {
    if (!s.files.shot || !s.variant || !s.size) continue;
    const base = {
      name: s.name,
      shot: s.shot,
      variant: s.variant,
      file: s.files.shot,
      size: s.size,
    };
    const refs = feature.refs.filter((r) => r.variant === s.variant && r.file && r.size);
    for (const ref of refs)
      pairs.push({
        ...base,
        ref,
        ...(ref.size ? sizesOf(s.size, ref.size) : { sizes: null, overlap: null }),
      });
    if (refs.length === 0 && feature.spec)
      pairs.push({ ...base, ref: null, sizes: null, overlap: null });
  }
  return pairs;
}

/** The mean of `img`'s pixels in the box from (x0, y0) up to (x1, y1), written at `out[o]`. */
function average(img: PNG, box: [number, number, number, number], out: Buffer, o: number) {
  const [x0, y0, x1, y1] = box;
  const sum = [0, 0, 0, 0];
  for (let sy = y0; sy < y1; sy++)
    for (let sx = x0; sx < x1; sx++) {
      const i = (sy * img.width + sx) << 2;
      for (let c = 0; c < 4; c++) sum[c] = (sum[c] ?? 0) + (img.data[i + c] ?? 0);
    }
  const n = Math.max(1, (x1 - x0) * (y1 - y0));
  for (let c = 0; c < 4; c++) out[o + c] = Math.round((sum[c] ?? 0) / n);
}

/** Box-average `img` down to `width` pixels wide. */
function shrink(img: PNG, width: number): PNG {
  const height = Math.max(1, Math.round((img.height * width) / img.width));
  const out = new PNG({ width, height });
  const fx = img.width / width;
  const fy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.ceil((y + 1) * fy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.ceil((x + 1) * fx)));
      average(img, [x0, y0, x1, y1], out.data, (y * width + x) << 2);
    }
  }
  return out;
}

/** A PNG inline as a data URL, scaled down to at most `maxWidth` pixels wide. */
export async function inlinePng(file: string, maxWidth = 1024): Promise<string> {
  const buf = Buffer.from(await Bun.file(file).arrayBuffer());
  const img = PNG.sync.read(buf);
  const out = img.width > maxWidth ? PNG.sync.write(shrink(img, maxWidth)) : buf;
  return `data:image/png;base64,${out.toString("base64")}`;
}

/** What a session needs to resolve its target's feature: the config's entry and where to shoot. */
export type FeatureSource = Omit<Resolve, "fetched" | "refresh"> & { def: Feature };

/** The feature as it stands: the spec read now, the refs resolved (`refresh` refetches Figma). */
export async function loadFeature(src: FeatureSource, refresh: boolean): Promise<DevFeature> {
  return { spec: await readSpec(src.def), refs: await resolveRefs(src.def, { ...src, refresh }) };
}
