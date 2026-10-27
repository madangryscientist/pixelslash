/**
 * A stand-in for github.com and api.github.com, enough for the OAuth web flow: authorize
 * bounces straight back with a code, the code buys a token, the token reads one fixed user. It also
 * answers as a project's model, so no e2e run sends a shot anywhere else.
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

const STUB_MODEL_ANSWER = "LABEL noise\nWHY Text edges moved by a sub-pixel.";
const STUB_SUMMARY_ANSWER = "The hero's text edges moved by a sub-pixel. [C1]";
/** For a build with a brief (PS-232): the same sentence, then the closing one about the brief. */
const STUB_BRIEF_ANSWER = `${STUB_SUMMARY_ANSWER}\nBrief: the hero changed as the brief says; nothing it describes is missing. [C1]`;

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
  // An OpenAI-compatible vision endpoint for a project's own model (ob 1473): every region is noise.
  // The build's text-only summary call (ob 1668) gets a sentence about its first changed item, and
  // one about its brief when it has one (PS-232).
  "/v1/chat/completions": async (req, res) => {
    const text = JSON.stringify(await readJson(req));
    let content = STUB_SUMMARY_ANSWER;
    if (text.includes("image_url")) content = STUB_MODEL_ANSWER;
    else if (text.includes("Brief, as the uploader wrote it")) content = STUB_BRIEF_ANSWER;
    if (req.headers.authorization === "Bearer sk-e2e-model")
      json(res, { choices: [{ message: { role: "assistant", content } }] });
    else res.writeHead(401).end();
  },
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = ROUTES[url.pathname];
  if (route) void route(req, res, url);
  else res.writeHead(404).end();
}).listen(Number(process.env["PIXELSLASH_E2E_STUB_PORT"] ?? 4174));
