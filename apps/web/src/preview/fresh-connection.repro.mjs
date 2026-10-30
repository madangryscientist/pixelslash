// Run by fresh-connection.test.ts under Node, which is what `vite preview` runs on: Bun's own
// socket handling does not fail the way Node's does. Prints the outcome of two finalizes sent
// one after the other through undici's Pool, the class miniflare sends workerd's requests with.
import { createServer } from "node:http";
import { resolve } from "node:path";
import { freshConnectionPerRequest, miniflareUndici } from "./fresh-connection.ts";

const HOLD_MS = 200;
const CLOSE_AFTER_MS = 40;

const workerd = createServer((req, res) => {
  req.resume();
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"done"}');
    setTimeout(() => req.socket.destroy(), CLOSE_AFTER_MS);
  }, HOLD_MS);
});
await new Promise((done) => workerd.listen(0, "127.0.0.1", done));

const root = resolve(import.meta.dirname, "../..");
const { Pool } = miniflareUndici(root);
// the plugin's own preview hook, as `vite preview` calls it
if (process.argv[2] === "fresh")
  freshConnectionPerRequest().configurePreviewServer({ config: { root } });

const pool = new Pool(`http://127.0.0.1:${workerd.address().port}`, {
  keepAliveTimeout: 1000,
  keepAliveMaxTimeout: 1000,
});
const outcomes = [];
for (let i = 0; i < 2; i++) {
  // the CLI's next finalize reaches the pool a few ms after the first one is answered
  if (i > 0) await new Promise((done) => setTimeout(done, 5));
  try {
    // miniflare sends `reset: false` on every request
    const res = await pool.request({ path: "/finalize", method: "POST", reset: false });
    await res.body.text();
    outcomes.push(res.statusCode);
  } catch (error) {
    outcomes.push(error.code ?? String(error));
  }
}
process.stdout.write(JSON.stringify(outcomes));
await pool.close();
workerd.close();
