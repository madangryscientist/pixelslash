/**
 * The PS-204 timing worker. `POST /load?page=<name>` keeps a pair (main's length in `x-main-length`,
 * then both PNGs); `GET /run?impl=<impl>&page=<name>` does one piece of work on it and answers
 * with what it found. The driver times each request from outside, because workerd stops the clock
 * inside a request while code runs.
 *
 * impl: `pngjs` is the server diff as it runs today (`diffPngs`); `wasm` is the flag's
 * (`wasmDiffer`); `encode` is only the pngjs overlay encode both of them end with; `noop` is the
 * request alone.
 */
import { createHash } from "node:crypto";
import module from "@pixelslash/engine/diff.wasm";
import { diffPngs } from "@pixelslash/engine/diff";
import { wasmDiffer } from "@pixelslash/engine/diff-wasm";
import { pngjsCodec } from "@pixelslash/engine/png-codec";

const pairs = new Map<string, [Buffer, Buffer]>();
const overlays = new Map<string, ReturnType<typeof pngjsCodec.decode>>();
const fellBack: string[] = [];
const wasm = wasmDiffer(module, { fellBack: (reason) => fellBack.push(String(reason)) });

const json = (body: unknown) => Response.json(body);
const IMPLS = { pngjs: diffPngs, wasm };

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

function run(url: URL, pair: [Buffer, Buffer]): Response {
  const impl = url.searchParams.get("impl") ?? "";
  if (impl !== "pngjs" && impl !== "wasm") return new Response(`no impl ${impl}`, { status: 400 });
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
    return run(url, pair);
  },
};
