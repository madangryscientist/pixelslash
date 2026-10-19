/**
 * A stand-in for github.com and api.github.com, enough for the OAuth web flow: authorize
 * bounces straight back with a code, the code buys a token, the token reads one fixed user.
 */
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

const STUB_USER = { id: 4242, login: "e2e-octocat", name: "E2E Octocat", avatar_url: null };

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => resolve(JSON.parse(raw)));
  });
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

const json = (res: ServerResponse, body: unknown) =>
  void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

const ROUTES: Record<string, Handler> = {
  "/health": (_req, res) => void res.end("ok"),
  "/login/oauth/authorize": (_req, res, url) => {
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", "stub-code");
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() }).end();
  },
  "/login/oauth/access_token": async (req, res) => {
    const body = await readJson(req);
    const ok =
      typeof body === "object" &&
      body !== null &&
      Reflect.get(body, "code") === "stub-code" &&
      Reflect.get(body, "client_secret") === "e2e-secret";
    json(res, ok ? { access_token: "stub-token" } : { error: "bad_verification_code" });
  },
  "/user": (req, res) => {
    if (req.headers.authorization === "Bearer stub-token") json(res, STUB_USER);
    else res.writeHead(401).end();
  },
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = ROUTES[url.pathname];
  if (route) void route(req, res, url);
  else res.writeHead(404).end();
}).listen(4174);
