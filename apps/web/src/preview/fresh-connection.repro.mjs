// Run by fresh-connection.test.ts under Node, which is what `vite preview` runs on: Bun's own
// socket handling does not fail the way Node's does. Prints the outcome of two finalizes sent
// one after the other through undici's Pool, the class miniflare sends workerd's requests with.
import { createServer } from "node:http";
import { resolve } from "node:path";
import { freshConnectionPerRequest, miniflareUndici } from "./fresh-connection.ts";

const HOLD_MS = 200;

// workerd closes the connection a moment after it answers. A clock cannot stand in for that: a
// loaded host lags past any delay between the first answer and the second send, and the second
// request then finds the socket already gone and opens a fresh one. What the CT's close does to the
// client is fail a request that was dispatched on the kept socket, so the server does exactly that:
// the first request on a socket is answered, a second one on the same socket is cut off unanswered.
const requestsOn = new WeakMap();
const workerd = createServer((req, res) => {
  req.resume();
  const count = (requestsOn.get(req.socket) ?? 0) + 1;
  requestsOn.set(req.socket, count);
  if (count > 1) {
    req.socket.destroy();
    return;
  }
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"done"}');
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
