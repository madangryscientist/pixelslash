/**
 * The self-host's diff sidecar (PS-203): the server diff with the napi-image codec. workerd cannot
 * load a native addon, so on a self-host the Worker sends each shot's two PNGs here over loopback
 * (`src/diff/sidecar.ts`) and gets back what `diffPngs` returns. It is the engine's own `diffPngs`
 * with the CLI's codec (PS-185), the same options and ignore areas: only the decode and the encode
 * are native, and `png-native.ts` falls back to pngjs for any file it does not hold equal.
 *
 * Bound to 127.0.0.1 and nothing else is served: the shots come from the Worker on the same machine
 * and go nowhere (invariant 4). Nothing is written to disk. Opt-in: the Worker calls it only when
 * `DIFF_SIDECAR_URL` is set, and falls back to pngjs in-process when it is down or errors. See
 * apps/web/README.md, "The diff sidecar".
 */
import { Buffer } from "node:buffer";
import { diffPngs } from "@pixelslash/engine/diff";
import { useNativePngCodec } from "@pixelslash/engine/png-native";
import { release } from "@pixelslash/engine/release";
import { SIDECAR_PATH, decodeRequest, encodeResponse } from "../../src/diff/sidecar-wire.ts";

/** wrangler.jsonc's `env.e2e` `DIFF_SIDECAR_URL` names this port. */
const DEFAULT_PORT = 4181;
/** Two full-page uploads; a Worker's own request limit is far below. Bun answers 413 above it. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const failure = (status: number, error: string) => Response.json({ error }, { status });
const log = (line: string) => process.stdout.write(`${line}\n`);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function handle(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/health") return new Response("ok");
  if (path !== SIDECAR_PATH || req.method !== "POST")
    return failure(404, `only POST ${SIDECAR_PATH} is served`);
  const body = Buffer.from(await req.arrayBuffer());
  try {
    let request: ReturnType<typeof decodeRequest>;
    try {
      request = decodeRequest(body);
    } catch (e) {
      // A frame this sidecar cannot read: the Worker and it are out of step, which the Worker logs.
      return failure(400, messageOf(e));
    }
    const { main, branch, options, ignore } = request;
    const started = performance.now();
    let result: ReturnType<typeof diffPngs>;
    try {
      result = diffPngs(main, branch, options, ignore);
    } catch (e) {
      // 422: the Worker measures it in-process, and pngjs reports the same bad file in its own words.
      log(`failed: ${messageOf(e)}`);
      return failure(422, messageOf(e));
    }
    log(
      `diff ${result.width}x${result.height} ${result.changedPixels} changed ` +
        `${Math.round(performance.now() - started)} ms`,
    );
    return new Response(encodeResponse(result), {
      headers: { "content-type": "application/octet-stream" },
    });
  } finally {
    // A process with a gc would free these in time; freed now, a burst does not pile them up.
    release(body);
  }
}

const native = await useNativePngCodec();
const port = Number(process.env["PIXELSLASH_DIFF_SIDECAR_PORT"] || DEFAULT_PORT);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize: MAX_BODY_BYTES,
  fetch: handle,
});
// Without the addon the sidecar still answers, with pngjs: slower, never different.
log(
  `diff sidecar on http://${server.hostname}:${server.port}${SIDECAR_PATH} ` +
    `(codec: ${native ? "napi-image" : "pngjs, the addon did not load"})`,
);
