/**
 * The diff.wasm timing worker. `POST /load?page=<name>` keeps a pair (main's length in
 * `x-main-length`, then both PNGs); `GET /run?impl=<impl>&page=<name>` diffs it and answers with
 * what it found. The driver times each request from outside, because workerd stops the clock
 * inside a request while code runs.
 *
 * impl: `wasm` is the server's diff (`wasmDiff`, the module the Worker imports); `noop` is the
 * request alone. With `&check` the answer is every field and the overlay's sha256.
 */
import { createHash } from "node:crypto";
import { wasmDiff } from "@pixelslash/engine/diff-wasm";

const pairs = new Map<string, [Buffer, Buffer]>();
const json = (body: unknown) => Response.json(body);

async function load(page: string, request: Request): Promise<Response> {
  const bytes = Buffer.from(await request.arrayBuffer());
  const split = Number(request.headers.get("x-main-length"));
  pairs.set(page, [bytes.subarray(0, split), bytes.subarray(split)]);
  return json({ page, bytes: bytes.length });
}

function run(url: URL, pair: [Buffer, Buffer]): Response {
  const { overlay, ...result } = wasmDiff(pair);
  if (!url.searchParams.has("check")) return json({ changedPixels: result.changedPixels });
  return json({ result, overlay: createHash("sha256").update(overlay).digest("hex") });
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
    if (impl !== "wasm") return new Response(`no impl ${impl}`, { status: 400 });
    return run(url, pair);
  },
};
