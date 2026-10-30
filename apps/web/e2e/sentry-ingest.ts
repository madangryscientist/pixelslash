/**
 * A stand-in for a Sentry ingest (PS-227): takes the envelopes the Worker and the browser POST to
 * `/api/<project>/envelope/` and keeps them, so a spec can read what would have left the machine.
 * Nothing is forwarded. `GET /envelopes` lists them as text, `DELETE /envelopes` forgets them.
 * The browser posts from another origin, so every answer carries CORS headers.
 */
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
};

const received: string[] = [];

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, body = "", type = "text/plain") =>
    void res.writeHead(status, { ...CORS, "content-type": type }).end(body);

  if (req.method === "OPTIONS") {
    send(204);
  } else if (url.pathname === "/health") {
    send(200, "ok");
  } else if (url.pathname === "/envelopes") {
    if (req.method === "DELETE") received.length = 0;
    send(200, JSON.stringify(received), "application/json");
  } else if (req.method === "POST" && /^\/api\/\d+\/envelope\/?$/.test(url.pathname)) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const plain = req.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body;
      received.push(plain.toString("utf8"));
      send(200, JSON.stringify({ id: "e2e" }), "application/json");
    });
  } else {
    send(404);
  }
}).listen(Number(process.env["PIXELSLASH_E2E_SENTRY_PORT"] ?? 4175));
