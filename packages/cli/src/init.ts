import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_NAMES, UsageError, isHttpUrl, parseConfig } from "@pixelslash/engine";
import { RemoteError, apiClient, isObj, type FetchLike } from "./api.ts";
import { storedToken } from "./credentials.ts";
import { listProjects, type Project } from "./remote.ts";
import { readFlagPairs } from "./args.ts";
import type { Io } from "./run.ts";

export const INIT_USAGE =
  "pixelslash init [--url URL | --storybook URL] [--routes /,/about] [--viewports 1280x720,375x812] [--themes light,dark] [--server URL] [--project NAME] [--yes] [--force]\nWrites pixelslash.config.ts and adds the snapshot dirs to .gitignore. Each flag answers its question; the rest are asked on stdin, or take their default with --yes. An existing config is kept unless --force.";

const FLAGS = ["url", "storybook", "routes", "viewports", "themes", "server", "project"] as const;
const SWITCHES = ["--yes", "--force"];
const CONFIG = "pixelslash.config.ts";
const IGNORED = ["pixelslash-snapshots/", ".pixelslash/"];
const PROBE_TIMEOUT_MS = 3_000;

/** One question, answered with a line; an empty line (or none) takes the default. */
export type Ask = (question: string) => Promise<string>;

export type InitDeps = {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  ask?: Ask;
};

type Answers = {
  url: string;
  storybook: boolean;
  routes: string[];
  viewports: { width: number; height: number }[];
  themes: ("light" | "dark")[];
  server: string | undefined;
  project: string | undefined;
};

/**
 * Answers from stdin, one line per question, the question on stderr. Piped stdin works the same as
 * a terminal, so `printf 'http://localhost:3000\n/\n' | pixelslash init` answers it.
 */
function stdinAsk(io: Io): Ask {
  let chunks: AsyncIterator<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  let buffered = "";
  let done = false;
  return async (question) => {
    io.stderr.write(question);
    chunks ??= Bun.stdin.stream()[Symbol.asyncIterator]();
    while (!buffered.includes("\n") && !done) {
      const chunk = await chunks.next();
      if (chunk.done) done = true;
      else buffered += decoder.decode(chunk.value, { stream: true });
    }
    const end = buffered.indexOf("\n");
    const line = end === -1 ? buffered : buffered.slice(0, end);
    buffered = end === -1 ? "" : buffered.slice(end + 1);
    return line.trim();
  };
}

const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function url(text: string, what: string): string {
  if (!isHttpUrl(text)) throw new UsageError(`${what} must be an http(s) URL: ${text}`);
  return text.replace(/\/+$/, "");
}

function routes(text: string): string[] {
  const paths = list(text);
  const bad = paths.find((p) => !p.startsWith("/"));
  if (bad !== undefined) throw new UsageError(`route must start with /: ${bad}`);
  return paths.length === 0 ? ["/"] : [...new Set(paths)];
}

function viewports(text: string): Answers["viewports"] {
  return list(text).map((v) => {
    const m = /^(\d+)x(\d+)$/.exec(v);
    const [width, height] = [Number(m?.[1]), Number(m?.[2])];
    if (!m || width <= 0 || height <= 0) throw new UsageError(`viewport must be WxH: ${v}`);
    return { width, height };
  });
}

function themes(text: string): Answers["themes"] {
  return [...new Set(list(text))].map((t) => {
    if (t !== "light" && t !== "dark") throw new UsageError(`theme must be light or dark: ${t}`);
    return t;
  });
}

/** True when `<url>/index.json` answers as a Storybook index does. A down URL is simply not one. */
async function isStorybook(base: string, fetch: FetchLike): Promise<boolean> {
  try {
    const res = await fetch(`${base}/index.json`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return isObj(body) && isObj(body.entries);
  } catch {
    return false;
  }
}

/** The projects the token this machine holds for `server` sees; nothing when not logged in. */
async function projectsOn(
  server: string,
  env: NodeJS.ProcessEnv,
  fetch: FetchLike,
  io: Io,
): Promise<Project[]> {
  const token = env.PIXELSLASH_TOKEN?.trim() || (await storedToken(env, server));
  if (!token) {
    io.stderr.write(`not logged in to ${server}: the project is left for you to fill in\n`);
    return [];
  }
  try {
    return await listProjects(apiClient(server, token, fetch));
  } catch (e) {
    if (!(e instanceof RemoteError)) throw e;
    io.stderr.write(`could not read the projects on ${server} (${e.message})\n`);
    return [];
  }
}

type Flags = Partial<Record<(typeof FLAGS)[number], string>>;

/** What a question needs: its flag, else the line it is answered with, else its default. */
type Asking = { flags: Flags; ask: Ask; fetch: FetchLike; env: NodeJS.ProcessEnv; io: Io };

async function given(
  a: Asking,
  flag: string | undefined,
  question: string,
  fallback: string,
): Promise<string> {
  return flag ?? ((await a.ask(`${question} [${fallback}]: `)) || fallback);
}

/** The app URL, and whether it is a Storybook (`--storybook`, or its `index.json` answers). */
async function appSource(a: Asking): Promise<{ url: string; storybook: boolean }> {
  const { flags } = a;
  if (flags.storybook !== undefined)
    return { url: url(flags.storybook, "--storybook"), storybook: true };
  const base = url(
    await given(a, flags.url, "App URL (or a running Storybook)", "http://localhost:3000"),
    "the app URL",
  );
  const storybook = await isStorybook(base, a.fetch);
  if (storybook) a.io.stderr.write(`Storybook found at ${base}: every story is shot\n`);
  return { url: base, storybook };
}

/** The server, and the project on it: named, the only one the token sees, or picked from several. */
async function target(a: Asking): Promise<Pick<Answers, "server" | "project">> {
  const text = a.flags.server ?? (a.env.PIXELSLASH_SERVER || (await a.ask("Server URL [none]: ")));
  const server = text ? url(text, "the server") : undefined;
  if (!server || a.flags.project !== undefined) return { server, project: a.flags.project };
  const names = (await projectsOn(server, a.env, a.fetch, a.io)).map((p) => p.name);
  if (names.length <= 1) return { server, project: names[0] };
  const picked = await a.ask(`Project (${names.join(", ")}) [none]: `);
  if (picked && !names.includes(picked))
    throw new UsageError(`"${picked}" is not one of: ${names.join(", ")}`);
  return { server, project: picked || undefined };
}

async function answer(flags: Flags, yes: boolean, io: Io, deps: InitDeps): Promise<Answers> {
  const a: Asking = {
    flags,
    ask: yes ? async () => "" : (deps.ask ?? stdinAsk(io)),
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    env: deps.env ?? process.env,
    io,
  };
  const app = await appSource(a);
  const paths = app.storybook
    ? []
    : routes(await given(a, flags.routes, "Routes, comma-separated", "/"));
  return {
    ...app,
    routes: paths,
    viewports: viewports(await given(a, flags.viewports, "Viewports", "1280x720")),
    themes: themes(await given(a, flags.themes, "Themes (light, dark)", "light")),
    ...(await target(a)),
  };
}

/**
 * The answers through the loader's own checks before anything is written, so what `init` writes
 * always loads: two viewports alike, or `/a` and `/a/` (one route name), are refused here.
 */
function check(a: Answers): void {
  parseConfig({
    ...(a.storybook ? { storybook: { url: a.url } } : { baseUrl: a.url, routes: a.routes }),
    variants: a.viewports.flatMap((viewport) => a.themes.map((theme) => ({ viewport, theme }))),
    upload: { server: a.server, project: a.project },
  });
}

const q = (s: string) => JSON.stringify(s);

/** The config's source. Strings go through `JSON.stringify`, so an answer cannot break out of one. */
export function configSource(a: Answers): string {
  const variants = a.viewports.flatMap((v) =>
    a.themes.map(
      (t) => `    { viewport: { width: ${v.width}, height: ${v.height} }, theme: ${q(t)} },`,
    ),
  );
  const upload = [
    a.server ? `server: ${q(a.server)}` : `// server: "https://<your pixelslash server>"`,
    a.project ? `project: ${q(a.project)}` : `// project: "<project name>"`,
  ];
  return [
    "// Written by `pixelslash init`. Every option is in the PixelSlash CLI reference (docs/cli.md).",
    "// No token goes in here: `pixelslash login`, or PIXELSLASH_TOKEN in CI.",
    "export default {",
    ...(a.storybook
      ? [`  storybook: { url: ${q(a.url)} },`]
      : [`  baseUrl: ${q(a.url)},`, `  routes: [${a.routes.map(q).join(", ")}],`]),
    "  variants: [",
    ...variants,
    "  ],",
    '  // A shot that differs from itself: "review" (the default) puts it in front of a reviewer,',
    '  // "skip" keeps it out of review. A route (or a story tag) can set its own.',
    '  // flaky: "review",',
    "  upload: {",
    ...upload.map((line) => `    ${line.startsWith("//") ? line : `${line},`}`),
    "  },",
    "};",
    "",
  ].join("\n");
}

const bare = (line: string) => line.trim().replace(/^\/+|\/+$/g, "");

/** Append the entries `.gitignore` lacks; a line already there (with or without `/`s) counts. */
async function ignoreSnapshots(cwd: string): Promise<string[]> {
  const path = join(cwd, ".gitignore");
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  const have = new Set(text.split("\n").map(bare));
  const missing = IGNORED.filter((e) => !have.has(bare(e)));
  if (missing.length === 0) return [];
  const lead = text === "" || text.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${text}${lead}${missing.join("\n")}\n`);
  return missing;
}

const NEXT = `next:
  pixelslash check                  # this checkout against the server's baselines; uploads nothing
  pixelslash capture --upload       # shoot every route and open a build on the server

in CI (plain shell steps; the job needs full git history):
  export PIXELSLASH_SERVER=https://<server>
  export PIXELSLASH_TOKEN="$PIXELSLASH_CI_TOKEN"   # the CI's secret store, never git
  pixelslash capture --config ${CONFIG}
  pixelslash upload pixelslash-snapshots --wait --timeout 30m
  # exit 0 accepted or unchanged · 4 rejected · 5 still waiting · 3 server or build error · 2 usage
`;

/** `pixelslash init`: a config, the snapshot dirs ignored, and the commands to run next. */
export async function runInit(argv: string[], io: Io, deps: InitDeps = {}): Promise<number> {
  const yes = argv.includes("--yes");
  const force = argv.includes("--force");
  const flags = readFlagPairs(
    argv.filter((a) => !SWITCHES.includes(a)),
    FLAGS,
  );
  if (flags.url !== undefined && flags.storybook !== undefined)
    throw new UsageError("--url and --storybook: give one");
  const cwd = deps.cwd ?? process.cwd();
  const existing = CONFIG_NAMES.find((n) => existsSync(join(cwd, n)));
  if (existing && !force) throw new UsageError(`${existing} already exists: --force replaces it`);
  const answers = await answer(flags, yes, io, deps);
  check(answers);
  const source = configSource(answers);
  await writeFile(join(cwd, CONFIG), source);
  io.stdout.write(`wrote ${CONFIG}\n`);
  if (existing && existing !== CONFIG)
    io.stderr.write(`${existing} is still there; ${CONFIG} is read first, so delete it\n`);
  const added = await ignoreSnapshots(cwd);
  io.stdout.write(
    added.length > 0
      ? `.gitignore: added ${added.join(" ")}\n`
      : ".gitignore: already ignores the snapshot dirs\n",
  );
  io.stdout.write(`\n${NEXT}`);
  return 0;
}
