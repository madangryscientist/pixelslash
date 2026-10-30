import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FigmaError, UsageError } from "./errors.ts";

const FIGMA_API = "https://api.figma.com/v1";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type Component = { id: string; name: string };

/** A token from `--token-path`, else the env var `name` (the Figma token, or `PIXELSLASH_TOKEN` for upload). */
export async function resolveToken(
  tokenPath: string | undefined,
  env: NodeJS.ProcessEnv,
  name = "FIGMA_TOKEN",
): Promise<string> {
  if (tokenPath) {
    if (!existsSync(tokenPath)) throw new UsageError(`token file not found: ${tokenPath}`);
    const t = (await readFile(tokenPath, "utf8")).trim();
    if (!t) throw new UsageError(`token file empty: ${tokenPath}`);
    return t;
  }
  const t = env[name]?.trim();
  if (t) return t;
  throw new UsageError(`need ${name} or --token-path`);
}

function stringField(node: object, key: "id" | "name" | "type"): string {
  if (!(key in node)) return "";
  const value: unknown = Reflect.get(node, key);
  return typeof value === "string" ? value : "";
}

function collectComponents(node: unknown, out: Component[]): void {
  if (!node || typeof node !== "object") return;
  const id = stringField(node, "id");
  const name = stringField(node, "name");
  if (stringField(node, "type") === "COMPONENT" && id && name) {
    out.push({ id, name });
    return;
  }
  const children: unknown = "children" in node ? node.children : undefined;
  if (Array.isArray(children)) {
    for (const child of children) collectComponents(child, out);
  }
}

/** The `images` map of a Figma images response, keeping only string URLs. */
function imageUrls(body: unknown): Map<string, string> {
  const urls = new Map<string, string>();
  if (!body || typeof body !== "object" || !("images" in body)) return urls;
  const images: unknown = body.images;
  if (!images || typeof images !== "object") return urls;
  for (const [id, url] of Object.entries(images)) {
    if (typeof url === "string" && url) urls.set(id, url);
  }
  return urls;
}

function pngFile(name: string): string {
  return `${name.replace(/[/\\]/g, "-")}.png`;
}

async function listComponents(
  fileKey: string,
  headers: Record<string, string>,
  fetch: FetchLike,
): Promise<Component[]> {
  const fileRes = await fetch(`${FIGMA_API}/files/${fileKey}`, { headers });
  if (!fileRes.ok) throw new FigmaError(`figma file ${fileRes.status}`);
  const body: unknown = await fileRes.json();
  const document =
    body && typeof body === "object" && "document" in body ? body.document : undefined;
  const components: Component[] = [];
  collectComponents(document, components);
  if (components.length === 0) throw new FigmaError(`no components in Figma file ${fileKey}`);
  return components;
}

/** Fetch every COMPONENT in a Figma file as `<name>.png` into `dest`. */
export async function fetchFigmaRasters(opts: {
  fileKey: string;
  token: string;
  dest: string;
  fetch: FetchLike;
}): Promise<void> {
  const headers = { "X-Figma-Token": opts.token };
  const components = await listComponents(opts.fileKey, headers, opts.fetch);

  const imgUrl = new URL(`${FIGMA_API}/images/${opts.fileKey}`);
  imgUrl.searchParams.set("ids", components.map((c) => c.id).join(","));
  imgUrl.searchParams.set("format", "png");
  const imgRes = await opts.fetch(imgUrl.href, { headers });
  if (!imgRes.ok) throw new FigmaError(`figma images ${imgRes.status}`);
  const images = imageUrls(await imgRes.json());

  await mkdir(opts.dest, { recursive: true });
  for (const c of components) {
    const pngUrl = images.get(c.id);
    if (!pngUrl) continue;
    const pngRes = await opts.fetch(pngUrl);
    if (!pngRes.ok) throw new FigmaError(`figma raster ${pngRes.status} for ${c.name}`);
    await Bun.write(join(opts.dest, pngFile(c.name)), new Uint8Array(await pngRes.arrayBuffer()));
  }
}

/** A frame's width in Figma's own units, from `/files/:key/nodes`. */
async function frameWidth(
  fileKey: string,
  nodeId: string,
  headers: Record<string, string>,
  fetch: FetchLike,
): Promise<number> {
  const url = new URL(`${FIGMA_API}/files/${fileKey}/nodes`);
  url.searchParams.set("ids", nodeId);
  const res = await fetch(url.href, { headers });
  if (!res.ok) throw new FigmaError(`figma nodes ${res.status}`);
  let width: unknown = await res.json();
  for (const key of ["nodes", nodeId, "document", "absoluteBoundingBox", "width"])
    width = width && typeof width === "object" ? Reflect.get(width, key) : undefined;
  if (typeof width !== "number" || width <= 0)
    throw new FigmaError(`no frame ${nodeId} in Figma file ${fileKey}`);
  return width;
}

/**
 * One Figma frame as a PNG `width` pixels wide (ob 1741): the viewport width times the device
 * scale factor, so it sits beside the shot at the same scale. Figma scales between 0.01 and 4.
 */
export async function fetchFigmaFrame(opts: {
  fileKey: string;
  nodeId: string;
  token: string;
  width: number;
  fetch: FetchLike;
}): Promise<Uint8Array> {
  const headers = { "X-Figma-Token": opts.token };
  const frame = await frameWidth(opts.fileKey, opts.nodeId, headers, opts.fetch);
  const scale = Math.min(4, Math.max(0.01, opts.width / frame));
  const imgUrl = new URL(`${FIGMA_API}/images/${opts.fileKey}`);
  imgUrl.searchParams.set("ids", opts.nodeId);
  imgUrl.searchParams.set("format", "png");
  imgUrl.searchParams.set("scale", String(scale));
  const imgRes = await opts.fetch(imgUrl.href, { headers });
  if (!imgRes.ok) throw new FigmaError(`figma images ${imgRes.status}`);
  const pngUrl = imageUrls(await imgRes.json()).get(opts.nodeId);
  if (!pngUrl) throw new FigmaError(`figma rendered nothing for ${opts.nodeId}`);
  const pngRes = await opts.fetch(pngUrl);
  if (!pngRes.ok) throw new FigmaError(`figma raster ${pngRes.status} for ${opts.nodeId}`);
  return new Uint8Array(await pngRes.arrayBuffer());
}
