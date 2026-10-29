/**
 * A stand-in for github.com and api.github.com, enough for the OAuth web flow: authorize
 * bounces straight back with a code, the code buys a token, the token reads one fixed user. It is
 * Google's sign-in too (PS-274), PKCE checked, answering as a Google account with the same verified
 * email, so the two sign-ins meet on one user. It also answers as a project's model, so no e2e run
 * sends a shot anywhere else.
 */
import { createHash } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

const STUB_USER = { id: 4242, login: "e2e-octocat", name: "E2E Octocat", avatar_url: null };
const STUB_EMAIL = "octocat@e2e.test";
const STUB_GOOGLE_USER = {
  sub: "google-e2e-1",
  email: STUB_EMAIL,
  email_verified: true,
  name: "E2E Octocat",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => resolve(raw));
  });
}

const readJson = async (req: IncomingMessage): Promise<unknown> => JSON.parse(await readBody(req));

/** Each Google code, until spent, and the PKCE challenge its authorize call carried. */
const googleCodes = new Map<string, string>();

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

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
  "/user/emails": (req, res) => {
    if (req.headers.authorization === "Bearer stub-token")
      json(res, [{ email: STUB_EMAIL, primary: true, verified: true }]);
    else res.writeHead(401).end();
  },
  "/o/oauth2/v2/auth": (_req, res, url) => {
    if (url.searchParams.get("code_challenge_method") !== "S256") {
      res.writeHead(400).end();
      return;
    }
    const code = `google-code-${crypto.randomUUID()}`;
    googleCodes.set(code, url.searchParams.get("code_challenge") ?? "");
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() }).end();
  },
  "/token": async (req, res) => {
    const form = new URLSearchParams(await readBody(req));
    const code = form.get("code") ?? "";
    const challenge = googleCodes.get(code);
    googleCodes.delete(code);
    const ok =
      challenge !== undefined &&
      form.get("client_secret") === "e2e-google-secret" &&
      s256(form.get("code_verifier") ?? "") === challenge;
    if (ok) json(res, { access_token: "stub-google-token", token_type: "Bearer" });
    else
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_grant"}');
  },
  "/v1/userinfo": (req, res) => {
    if (req.headers.authorization === "Bearer stub-google-token") json(res, STUB_GOOGLE_USER);
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
