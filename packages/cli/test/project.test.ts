import { afterAll, describe, expect, test } from "vitest";
import { isObj, str } from "../src/api.ts";
import { run } from "../src/run.ts";
import { capture, cleanup } from "./support.ts";
import { SERVER, fakeApi, home, login, project } from "./remote-support.ts";

afterAll(cleanup);

const ORG_TOKEN = "psorg_secret_org_token";

/** The fake API plus `POST /api/v1/projects`, idempotent on the name as the server is. */
function api(opts: { token?: string; refuse?: boolean } = {}) {
  const token = opts.token ?? ORG_TOKEN;
  const base = fakeApi({ tokens: [token], projects: [project("p1", "web")] });
  base.replies["/api/v1/projects/p1/flakes"] = { api_version: 1, flakes: [] };
  const known = new Map([["web", "p1"]]);
  const fetch = async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    if (init?.method !== "POST" || url.pathname !== "/api/v1/projects")
      return base.fetch(raw, init);
    const text = typeof init.body === "string" ? init.body : "";
    base.seen.push({
      method: "POST",
      url,
      auth: new Headers(init.headers).get("authorization"),
      agent: null,
      body: text,
    });
    if (opts.refuse)
      return Response.json(
        { api_version: 1, error: { code: "forbidden", message: "not for you" } },
        { status: 403 },
      );
    const sent: unknown = JSON.parse(text);
    const name = isObj(sent) ? str(sent.name) : "";
    const created = !known.has(name);
    if (created) known.set(name, `p${known.size + 1}`);
    return Response.json(
      {
        api_version: 1,
        id: known.get(name),
        name,
        org: { id: "org-Acme", name: "Acme" },
        created,
      },
      { status: created ? 201 : 200 },
    );
  };
  return { ...base, fetch };
}

async function projectCmd(argv: string[], fake = api()) {
  const cap = capture();
  const code = await run(["project", ...argv, "--server", SERVER], cap.io, {
    env: { PIXELSLASH_TOKEN: ORG_TOKEN, HOME: await home().then((h) => h.HOME) },
    fetch: fake.fetch,
  });
  return { code, cap, fake };
}

describe("pixelslash project create", () => {
  test("makes a new project, says so, and posts only the name", async () => {
    const { code, cap, fake } = await projectCmd(["create", "docs"]);
    expect(code).toBe(0);
    expect(cap.stdout).toBe("created: docs (Acme) p2\n");
    const post = fake.seen.find((s) => s.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ name: "docs" });
    expect(cap.stdout + cap.stderr).not.toContain(ORG_TOKEN);
  });

  test("is idempotent: an existing name is reported, exit 0", async () => {
    const fake = api();
    const first = await projectCmd(["create", "docs"], fake);
    const second = await projectCmd(["create", "docs"], fake);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.cap.stdout).toBe("already exists: docs (Acme) p2\n");
    const web = await projectCmd(["create", "web"], fake);
    expect(web.cap.stdout).toBe("already exists: web (Acme) p1\n");
  });

  test("--json is the server's reply as sent; --org is passed on", async () => {
    const { code, cap, fake } = await projectCmd(["create", "docs", "--org", "Acme", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout)).toMatchObject({ name: "docs", created: true });
    const post = fake.seen.find((s) => s.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ name: "docs", org: "Acme" });
  });

  test("a server refusal is exit 1", async () => {
    const { code, cap } = await projectCmd(["create", "docs"], api({ refuse: true }));
    expect(code).toBe(1);
    expect(cap.stderr).toContain("403 forbidden: not for you");
    expect(cap.stderr).not.toContain(ORG_TOKEN);
  });

  test("a missing name or verb is exit 2", async () => {
    expect((await projectCmd(["create"])).code).toBe(2);
    expect((await projectCmd(["create", "--json"])).code).toBe(2);
    expect((await projectCmd([])).code).toBe(2);
    expect((await projectCmd(["delete", "x"])).code).toBe(2);
  });
});

describe("pixelslash project list", () => {
  test("prints each project, or the reply with --json", async () => {
    const plain = await projectCmd(["list"]);
    expect(plain.code).toBe(0);
    expect(plain.cap.stdout).toBe("web (Acme) p1\n");
    const json = await projectCmd(["list", "--json"]);
    expect(JSON.parse(json.cap.stdout).projects).toHaveLength(1);
  });
});

async function flakes(extra: string[]) {
  const fake = api();
  const cap = capture();
  const code = await run(["flakes", "--server", SERVER, ...extra], cap.io, {
    env: { PIXELSLASH_TOKEN: ORG_TOKEN, HOME: (await home()).HOME },
    fetch: fake.fetch,
  });
  return { code, cap, fake };
}

describe("an org token names its project", () => {
  test("neither --project nor upload.project is exit 2, naming both", async () => {
    const { code, cap } = await flakes([]);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("--project");
    expect(cap.stderr).toContain("upload.project");
  });

  test("an unknown name is exit 2, names it and the command that makes it", async () => {
    const { code, cap, fake } = await flakes(["--project", "typo"]);
    expect(code).toBe(2);
    expect(cap.stderr).toContain('"typo"');
    expect(cap.stderr).toContain("pixelslash project create typo");
    expect(fake.seen.some((s) => s.method === "POST")).toBe(false);
  });

  test("a known name resolves like a personal token's", async () => {
    const { code, fake } = await flakes(["--project", "web"]);
    expect(code).toBe(0);
    expect(fake.seen.some((s) => s.url.pathname === "/api/v1/projects/p1/flakes")).toBe(true);
  });

  test("whoami says it is an org token", async () => {
    const fake = fakeApi({ tokens: [ORG_TOKEN], projects: [project("p1", "web")] });
    fake.replies["/api/v1/me"] = { kind: "org-ci", orgId: "org-Acme" };
    const cap = capture();
    const code = await run(["whoami", "--server", SERVER], cap.io, {
      env: { PIXELSLASH_TOKEN: ORG_TOKEN, HOME: (await home()).HOME },
      fetch: fake.fetch,
    });
    expect(code).toBe(0);
    expect(cap.stdout).toContain("org token for Acme");
    expect(cap.stdout).toContain("projects: web");
  });

  test("login refuses it, exit 2, and stores nothing", async () => {
    const env = await home();
    const { code, cap } = await login(env, fakeApi({ tokens: [ORG_TOKEN] }), ORG_TOKEN);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("psorg_");
    expect(cap.stderr).not.toContain(ORG_TOKEN);
  });
});
