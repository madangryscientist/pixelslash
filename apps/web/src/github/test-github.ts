import { generateKeyPairSync } from "node:crypto";
import { type GithubTokenConfig, createGithubToken } from "./token";
import { type GithubAppConfig, type GithubAppDeps, type GithubFetch, createGithubApp } from "./app";

/** A stand-in for GitHub's REST API, for the App's tests: no network. Tests only. */

const TEST_APP_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});

export const TEST_TOKEN = "github_pat_stub";
const TEST_TOKEN_CONFIG: GithubTokenConfig = {
  token: TEST_TOKEN,
  apiBase: "https://api.github.test",
};

const TEST_APP_CONFIG: GithubAppConfig = {
  appId: "123456",
  privateKey: TEST_APP_KEY,
  apiBase: "https://api.github.test",
};

/** One call GitHub got; `raw` is the JSON body as sent, empty for none. */
export type Call = { method: string; path: string; auth: string; raw: string };

/** What the stand-in does with the next calls: answer, fail with a status, or never answer. */
export type Mode = "ok" | { status: number } | "hang";

const reply = (status: number, body: unknown) =>
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

function never(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

function callOf(url: string, init: RequestInit): Call {
  return {
    method: init.method ?? "GET",
    path: new URL(url).pathname,
    auth: new Headers(init.headers).get("authorization") ?? "",
    raw: typeof init.body === "string" ? init.body : "",
  };
}

export function fakeGithub({ now = Date.now }: { now?: () => number } = {}) {
  const calls: Call[] = [];
  let mode: Mode = "ok";
  let minted = 0;
  let nextRun = 100;
  let nextStatus = 500;
  let nextComment = 900;
  /** The PR comments that exist, by id: a PATCH or DELETE of another id is GitHub's 404. */
  const comments = new Map<number, string>();
  /** A status the comment endpoints fail with, the rest of the API still answering. */
  let commentFailure: number | null = null;

  /** GitHub's answer to a call that gets one. */
  function route(method: string, path: string, body: string): Response {
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path))
      return reply(200, { id: 77 });
    if (method === "POST" && path === "/app/installations/77/access_tokens") {
      minted += 1;
      const expiresAt = new Date(now() + 60 * 60_000).toISOString();
      return reply(201, { token: `ghs_token${minted}`, expires_at: expiresAt });
    }
    return routeComments(method, path, body) ?? routeChecks(method, path);
  }

  /** The PR comment endpoints (PS-82): create on the PR's issue, edit and delete by id. */
  function routeComments(method: string, path: string, body: string): Response | null {
    if (commentFailure !== null && path.includes("/comments"))
      return reply(commentFailure, { message: "comments are down" });
    const text = () => {
      const sent: { body?: string } = JSON.parse(body);
      return sent.body ?? "";
    };
    if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(path)) {
      const id = nextComment++;
      comments.set(id, text());
      return reply(201, { id });
    }
    const edit = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path);
    if (!edit) return null;
    const id = Number(edit[1]);
    if (!comments.has(id)) return reply(404, { message: "Not Found" });
    if (method === "PATCH") {
      comments.set(id, text());
      return reply(200, { id });
    }
    if (method === "DELETE") {
      comments.delete(id);
      return reply(204, null);
    }
    return null;
  }

  /** The check-run and commit-status endpoints. */
  function routeChecks(method: string, path: string): Response {
    if (method === "POST" && path.endsWith("/check-runs")) return reply(201, { id: nextRun++ });
    if (method === "PATCH" && /\/check-runs\/\d+$/.test(path)) return reply(200, {});
    if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/statuses\/[0-9a-f]+$/.test(path))
      return reply(201, { id: nextStatus++ });
    return reply(404, { message: "Not Found" });
  }

  const fetch: GithubFetch = async (url, init) => {
    const call = callOf(url, init);
    calls.push(call);
    if (mode === "hang") return never(init.signal);
    if (mode !== "ok") return reply(mode.status, { message: "GitHub is down" });
    return route(call.method, call.path, call.raw);
  };

  return {
    fetch,
    calls,
    setMode: (next: Mode) => {
      mode = next;
    },
    /** The calls on check runs, without the token traffic. */
    checkRunCalls: () => calls.filter((c) => c.path.includes("/check-runs")),
    /** The calls on PR comments (PS-82). */
    commentCalls: () => calls.filter((c) => c.path.includes("/comments")),
    /** The PR comments that exist now: id to body. */
    comments: () => new Map(comments),
    /** From now on only the comment endpoints fail, with this status. */
    failComments: (status: number | null) => {
      commentFailure = status;
    },
    /** Someone deletes a comment on GitHub. */
    deleteComment: (id: number) => comments.delete(id),
    /** The calls on commit statuses (PS-235). */
    statusCalls: () => calls.filter((c) => c.path.includes("/statuses/")),
    token: (deps: GithubAppDeps = {}) => createGithubToken(TEST_TOKEN_CONFIG, { fetch, ...deps }),
    app: (deps: GithubAppDeps = {}) => createGithubApp(TEST_APP_CONFIG, { fetch, now, ...deps }),
  };
}
