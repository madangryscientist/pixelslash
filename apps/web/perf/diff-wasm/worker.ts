/**
 * The PS-204 timing worker. `POST /load?page=<name>` keeps a pair (main's length in `x-main-length`,
 * then both PNGs); `GET /run?impl=<impl>&page=<name>` does one piece of work on it and answers
 * with what it found. The driver times each request from outside, because workerd stops the clock
 * inside a request while code runs.
 *
 * impl: `pngjs` is the server diff as it runs today (`diffPngs`); `wasm` is the flag's
 * (`wasmDiffer`, its overlay filtered in wasm since PS-205); `wasm-pngjs` is the same with pngjs's
 * overlay encode, as it was before PS-205; `encode` is only the pngjs overlay encode, and `deflate`
 * only that encode's deflate; `noop` is the request alone.
 */
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import module from "@pixelslash/engine/diff.wasm";
import { diffPngs } from "@pixelslash/engine/diff";
import { wasmDiffer } from "@pixelslash/engine/diff-wasm";
import { pngjsCodec } from "@pixelslash/engine/png-codec";

const pairs = new Map<string, [Buffer, Buffer]>();
const overlays = new Map<string, ReturnType<typeof pngjsCodec.decode>>();
const fellBack: string[] = [];
const wasm = wasmDiffer(module, { fellBack: (reason) => fellBack.push(String(reason)) });

const json = (body: unknown) => Response.json(body);
const IMPLS = {
  pngjs: diffPngs,
  wasm,
  "wasm-pngjs": wasmDiffer(module, {
    fellBack: (reason) => fellBack.push(String(reason)),
    encode: (raster) => pngjsCodec.encode(raster),
  }),
};

async function load(page: string, request: Request): Promise<Response> {
  const bytes = Buffer.from(await request.arrayBuffer());
  const split = Number(request.headers.get("x-main-length"));
  pairs.set(page, [bytes.subarray(0, split), bytes.subarray(split)]);
  return json({ page, bytes: bytes.length });
}

/** The pngjs overlay encode alone, on the overlay decoded once. */
function encode(page: string, pair: [Buffer, Buffer]): Response {
  let raster = overlays.get(page);
  if (!raster) {
    const { overlay } = diffPngs(...pair);
    if (!overlay) return new Response(`no overlay for ${page}`, { status: 400 });
    raster = pngjsCodec.decode(overlay);
    overlays.set(page, raster);
  }
  return json({ bytes: pngjsCodec.encode(raster).length });
}

const filtered = new Map<string, Buffer>();

/** The overlay encode's deflate alone (pngjs's level 9, Z_RLE), on its filtered rows. */
function deflate(page: string, pair: [Buffer, Buffer]): Response {
  let rows = filtered.get(page);
  if (!rows) {
    const { overlay } = diffPngs(...pair);
    if (!overlay) return new Response(`no overlay for ${page}`, { status: 400 });
    rows = inflateSync(idatOf(overlay));
    filtered.set(page, rows);
  }
  return json({ bytes: deflateSync(rows, { chunkSize: 32 * 1024, level: 9, strategy: 3 }).length });
}

/** The IDAT data of a PNG with one IDAT, as pngjs writes it. */
function idatOf(png: Buffer): Buffer {
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT")
      return png.subarray(at + 8, at + 8 + length);
    at += 12 + length;
  }
  throw new Error("no IDAT");
}

function run(url: URL, pair: [Buffer, Buffer]): Response {
  const impl = url.searchParams.get("impl") ?? "";
  if (impl !== "pngjs" && impl !== "wasm" && impl !== "wasm-pngjs")
    return new Response(`no impl ${impl}`, { status: 400 });
  const { overlay, ...result } = IMPLS[impl](...pair);
  if (!url.searchParams.has("check")) return json({ changedPixels: result.changedPixels });
  // What the driver compares across the two implementations: every field and the overlay's bytes.
  const digest = createHash("sha256")
    .update(overlay ?? Buffer.alloc(0))
    .digest("hex");
  return json({ result, overlay: digest, fellBack });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const page = url.searchParams.get("page") ?? "";
    if (url.pathname === "/load") return load(page, request);
    if (url.pathname !== "/run") return new Response("not found", { status: 404 });
    const pair = pairs.get(page);
    if (!pair) return new Response(`no pair ${page}`, { status: 400 });
    const impl = url.searchParams.get("impl");
    if (impl === "noop") return json({});
    if (impl === "encode") return encode(page, pair);
    if (impl === "deflate") return deflate(page, pair);
    return run(url, pair);
  },
};
