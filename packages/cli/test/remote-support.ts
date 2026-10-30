import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, tmp } from "./support.ts";

export const SERVER = "https://ps.example";
export const USER_TOKEN = "psu_secret_user_token";

export type Seen = {
  method: string;
  url: URL;
  auth: string | null;
  agent: string | null;
  body: string;
};

export const project = (id: string, name: string, org = "Acme") => ({
  id,
  name,
  org: { id: `org-${org}`, name: org },
  default_branch: "main",
});

export const build = (id: string, branch = "feature") => ({
  id,
  project_id: "p1",
  branch,
  commit_sha: "4f2c1ab9d0e",
  pr_number: 42,
  status: "changes",
  error: null,
  counts: {
    changed: 1,
    new: 0,
    removed: 0,
    unchanged: 2,
    rebaseline: 0,
    unmeasured: 0,
    to_review: 1,
  },
  created_at: "2026-10-22T09:00:00.000Z",
  web_url: `${SERVER}/projects/p1/builds/${id}`,
});

/** A stand-in for `/api/v1` that knows one token per caller and records every request. */
export function fakeApi(opts: { tokens?: string[]; projects?: unknown[]; kind?: "ci" } = {}) {
  const tokens = opts.tokens ?? [USER_TOKEN];
  const projects = opts.projects ?? [project("p1", "web")];
  const seen: Seen[] = [];
  const replies: Record<string, unknown> = {
    "/api/v1/me":
      opts.kind === "ci"
        ? { kind: "ci", projectId: "p1" }
        : { kind: "user", user: { id: "u1", login: "ada", name: "Ada Lovelace" } },
    "/api/v1/projects": { api_version: 1, projects, next_cursor: null },
    "/api/v1/projects/p1/builds": {
      api_version: 1,
      builds: [build("b2"), build("b1")],
      next_cursor: null,
    },
    "/api/v1/builds/b2": {
      api_version: 1,
      build: {
        ...build("b2"),
        snapshots: [
          {
            name: "home",
            viewport: "1280x720",
            theme: "light",
            group: "changed",
            review_state: "pending",
          },
        ],
      },
    },
    "/api/v1/builds": { id: "build-9" },
    "/api/v1/builds/build-9/snapshots": { id: "s1" },
    "/api/v1/builds/build-9/finalize": {
      id: "build-9",
      status: "passed",
      error: null,
      unmeasured: 0,
    },
  };
  const fetch = async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ method: init?.method ?? "GET", url, auth, agent: headers.get("user-agent"), body });
    if (!tokens.some((t) => auth === `Bearer ${t}`))
      return Response.json(
        { api_version: 1, error: { code: "unauthorized", message: "invalid token" } },
        { status: 401 },
      );
    const reply = replies[url.pathname];
    if (reply === undefined)
      return Response.json(
        { api_version: 1, error: { code: "not_found", message: "not found" } },
        { status: 404 },
      );
    return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
  };
  return { seen, fetch, replies };
}

export async function home(): Promise<{ HOME: string }> {
  return { HOME: await tmp() };
}

export const credentials = (env: { HOME: string }) =>
  join(env.HOME, ".config", "pixelslash", "credentials.json");

export async function login(env: { HOME: string }, api = fakeApi(), token = USER_TOKEN) {
  const cap = capture();
  const code = await run(["login", "--server", SERVER], cap.io, {
    env,
    fetch: api.fetch,
    readSecret: async () => `${token}\n`,
  });
  return { code, cap };
}
