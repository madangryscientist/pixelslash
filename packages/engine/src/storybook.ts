import type { Page } from "playwright";
import type { Route, StorybookConfig } from "./config.ts";
import { CaptureError, UsageError } from "./errors.ts";
import { joinOrigin } from "./routes.ts";

const FETCH_TIMEOUT_MS = 10_000;

type Story = { id: string; title: string; name: string; tags: string[] };

/**
 * The index tag a story carries to be shot once, without the config's globals. A story's
 * parameters are not in `index.json`, but its tags are, and capture reads nothing else before it
 * opens a page.
 */
export const ONCE_TAG = "pixelslash-once";

/** Lower-case, camelCase split, everything outside letters and digits one `-`. */
function slug(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A global's name or value inside a snapshot name: case kept, anything outside `A-Za-z0-9_.-` a `-`. */
function globalSlug(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

/**
 * The snapshot name for a story under one set of globals: `<title>-<story name>` slugged, then
 * `@<global>=<value>` per global in the order the config lists them. It is what the server keys a
 * snapshot on, so it is built from the index entry alone and must not depend on anything that
 * changes between runs. It stays inside a path segment's alphabet (plus `@` and `=`).
 */
function storyName(story: Story, combo: [string, string][]): string {
  const base = slug(`${story.title} ${story.name}`) || slug(story.id) || "story";
  return base + combo.map(([k, v]) => `@${globalSlug(k)}=${globalSlug(v)}`).join("");
}

/** The route a story is shot at: Storybook's iframe, the story alone, the globals set from the URL. */
function storyPath(id: string, combo: [string, string][]): string {
  const globals = combo.map(([k, v]) => `${encodeURIComponent(k)}:${encodeURIComponent(v)}`);
  const query = [`id=${encodeURIComponent(id)}`, "viewMode=story"];
  if (globals.length > 0) query.push(`globals=${globals.join(";")}`);
  return `/iframe.html?${query.join("&")}`;
}

/** Each combination of the listed globals, one value per global; `[[]]` (one empty set) for none. */
function globalCombos(globals: Record<string, string[]>): [string, string][][] {
  let combos: [string, string][][] = [[]];
  for (const [key, values] of Object.entries(globals)) {
    combos = combos.flatMap((combo) => values.map((v): [string, string][] => [...combo, [key, v]]));
  }
  return combos;
}

function selected(story: Story, sb: Pick<StorybookConfig, "include" | "exclude">): boolean {
  const hit = (patterns: string[]) =>
    patterns.some((p) => {
      const glob = new Bun.Glob(p);
      return glob.match(story.id) || glob.match(story.title);
    });
  return hit(sb.include) && !hit(sb.exclude);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The stories in a Storybook 7+ `index.json` (`entries`); docs pages are not snapshots. */
function storiesIn(index: unknown, url: string): Story[] {
  if (!isObj(index) || !isObj(index["entries"]))
    throw new CaptureError(`storybook: ${url} has no "entries": needs Storybook 7 or later`);
  const stories: Story[] = [];
  for (const entry of Object.values(index["entries"])) {
    if (!isObj(entry) || entry["type"] !== "story") continue;
    const { id, title, name } = entry;
    if (typeof id !== "string" || typeof title !== "string" || typeof name !== "string")
      throw new CaptureError(`storybook: ${url} has a story without an id, title and name`);
    const tags = Array.isArray(entry["tags"])
      ? entry["tags"].filter((t): t is string => typeof t === "string")
      : [];
    stories.push({ id, title, name, tags });
  }
  return stories;
}

async function readIndex(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new CaptureError(
      `storybook: cannot read ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) throw new CaptureError(`storybook: ${url} answered HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new CaptureError(`storybook: ${url} is not JSON`);
  }
}

/**
 * One route per story × combination of globals, read from the running Storybook's `index.json`;
 * a story tagged `ONCE_TAG` is one route, at the globals' defaults. `taken` is the hand-written routes' names: a story that lands on one, or two that land on each
 * other, is a config error. A Storybook with nothing left after include/exclude is one too, since
 * a run that shoots nothing would pass for ever.
 */
export async function storybookRoutes(sb: StorybookConfig, taken: string[]): Promise<Route[]> {
  const indexUrl = joinOrigin(sb.url, "/index.json");
  const stories = storiesIn(await readIndex(indexUrl), indexUrl).filter((s) => selected(s, sb));
  if (stories.length === 0)
    throw new UsageError(`storybook: no story in ${indexUrl} matches include/exclude`);
  const owner = new Map(taken.map((name) => [name, "a route in routes"]));
  const routes: Route[] = [];
  for (const story of stories) {
    for (const combo of story.tags.includes(ONCE_TAG) ? [[]] : globalCombos(sb.globals)) {
      const name = storyName(story, combo);
      const clash = owner.get(name);
      if (clash)
        throw new UsageError(
          `config: storybook story "${story.id}" and ${clash} are both named "${name}"`,
        );
      owner.set(name, `story "${story.id}"`);
      routes.push({
        path: storyPath(story.id, combo),
        name,
        masks: sb.masks,
        ignore: [],
        tags: sb.tags,
        diff: {},
        variantDiff: {},
        variantIgnore: {},
        storybook: { origin: sb.url },
      });
    }
  }
  return routes;
}

/**
 * Browser globals the story check touches (the tsconfig has no DOM lib). Type-only: `storyState`
 * is serialized and runs in the page, where these are the real globals.
 */
declare const document: {
  body: { classList: { contains(name: string): boolean } };
  getElementById(id: string): { textContent: string | null; hasChildNodes(): boolean } | null;
};

type StoryState = { state: "ready" } | { state: "error"; message: string };

/**
 * Where the preview iframe is: Storybook marks `<body>` `sb-show-main` once a story is up,
 * `sb-show-errordisplay` when it threw (the message is in `#error-message`) and `sb-show-nopreview`
 * when the id names nothing. Null while it is still preparing. Runs in the page.
 */
function storyState(): StoryState | null {
  const body = document.body.classList;
  if (body.contains("sb-show-errordisplay")) {
    const message = document.getElementById("error-message")?.textContent?.trim() ?? "";
    return {
      state: "error",
      message: message.slice(0, 300) || "the preview shows its error display",
    };
  }
  if (body.contains("sb-show-nopreview"))
    return { state: "error", message: "the preview has no such story" };
  if (body.contains("sb-show-main") && document.getElementById("storybook-root")?.hasChildNodes())
    return { state: "ready" };
  return null;
}

/**
 * Wait until Storybook says the story rendered, within `timeoutMs`. A story that errors, or one
 * that never renders, fails the capture naming the snapshot.
 */
export async function awaitStory(page: Page, name: string, timeoutMs: number): Promise<void> {
  let state: StoryState | null;
  try {
    state = await (
      await page.waitForFunction(storyState, undefined, { timeout: timeoutMs })
    ).jsonValue();
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError")
      throw new CaptureError(`story ${name} did not render within ${timeoutMs}ms`);
    throw e;
  }
  if (state?.state === "error") throw new CaptureError(`story ${name} errored: ${state.message}`);
}
