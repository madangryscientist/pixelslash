import { join } from "node:path";
import { solidPng, tmp } from "./support.ts";

/** A git repo in a temp dir with `main` and a `feat` branch checked out, two commits apiece. */
export async function gitRepo(): Promise<string> {
  const dir = await tmp();
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: dir,
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  };
  await git("init", "-q", "-b", "main");
  await git("commit", "-q", "--allow-empty", "-m", "m0");
  await git("checkout", "-q", "-b", "feat");
  await git("commit", "-q", "--allow-empty", "-m", "f0");
  return dir;
}

export type UploadCall = {
  method: string;
  path: string;
  auth: string | null;
  /** A JSON body as sent; a form is not kept. */
  body?: string;
};

/** A stand-in for the upload API that records each request; `refuse` answers with that status instead. */
export function fakeUploadApi(refuse?: number) {
  const calls: UploadCall[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({
      method: init?.method ?? "GET",
      path,
      auth: new Headers(init?.headers).get("authorization"),
      ...(typeof init?.body === "string" && { body: init.body }),
    });
    if (refuse) return Response.json({ error: "no" }, { status: refuse });
    return Response.json({ id: "build-1", status: "passed" });
  };
  return { calls, fetch };
}

/** A snapshot dir with one PNG and its manifest. */
export async function snapshotDir(): Promise<string> {
  const dir = await tmp();
  await Bun.write(join(dir, "home.png"), solidPng(4, 4, [1, 2, 3, 255]));
  const entry = {
    name: "home",
    path: "/",
    variant: {
      name: "desktop",
      browser: "chromium",
      viewport: { width: 4, height: 4 },
      theme: "light",
    },
    tags: [],
    diff: { threshold: 0.2 },
    file: "home.png",
    fingerprint: { image: "version:t", browser: "chromium 1", fonts: "sha256:f" },
  };
  await Bun.write(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots: [entry] }));
  return dir;
}
