/**
 * Serves fixtures/capture/site for the capture fixture config: `/` is index.html,
 * `/motion` is motion.html. Usage: `bun scripts/serve-capture-fixture.ts [port]`.
 */
import { join } from "node:path";

const SITE = join(import.meta.dir, "..", "fixtures", "capture", "site");
const port = Number(process.argv[2] ?? 4791);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const name = path === "/" ? "index" : path.slice(1);
    if (!/^[a-z-]+$/.test(name)) return new Response("not found", { status: 404 });
    const file = Bun.file(join(SITE, `${name}.html`));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "content-type": "text/html" } });
  },
});
console.log(`capture fixture on http://127.0.0.1:${port}`);
