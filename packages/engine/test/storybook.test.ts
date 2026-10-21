import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { parseConfig } from "../src/config.ts";
import { captureSnapshots } from "../src/snapshot.ts";
import { storybookRoutes } from "../src/storybook.ts";

const entry = (id: string, title: string, name: string, type = "story") => [
  id,
  { type, id, title, name, importPath: "./x.stories.tsx", tags: [] },
];

/** An index entry that carries Storybook tags. */
const tagged = (id: string, title: string, name: string, tags: string[]) => [
  id,
  { type: "story", id, title, name, importPath: "./x.stories.tsx", tags },
];

const INDEX = {
  v: 5,
  entries: Object.fromEntries([
    entry("ui-button--primary", "UI/Button", "Primary"),
    entry("ui-button--page-heading", "UI/Button", "PageHeading"),
    entry("ui-button--docs", "UI/Button", "Docs", "docs"),
    entry("forms-input--empty", "Forms/Input", "Empty"),
    entry("forms-input--broken", "Forms/Input", "Broken"),
    entry("forms-input--hangs", "Forms/Input", "Hangs"),
  ]),
};

/** Storybook's iframe, reduced to the signals capture reads: body classes and `#storybook-root`. */
const IFRAME = `<!doctype html><body class="sb-show-preparing"><div id="storybook-root"></div>
<pre id="error-message"></pre><script>
const q = new URLSearchParams(location.search);
const id = q.get("id");
const theme = Object.fromEntries((q.get("globals") ?? "").split(";").filter(Boolean).map((p) => p.split(":"))).theme ?? "none";
const colour = { none: "#ffffff", "catppuccin-mocha": "#1e1e2e" }[theme] ?? "#ff0000";
document.body.style.cssText = "margin:0;background:" + colour;
if (id.endsWith("--broken")) {
  document.getElementById("error-message").textContent = "Error: boom in " + id;
  document.body.className = "sb-show-errordisplay";
} else if (!id.endsWith("--hangs")) {
  document.getElementById("storybook-root").innerHTML = "<div style='height:40px;width:60px'>" + id + "</div>";
  document.body.className = "sb-show-main";
}
</script>`;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/index.json") return Response.json(INDEX);
    if (pathname === "/iframe.html")
      return new Response(IFRAME, { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  },
});
const url = `http://127.0.0.1:${server.port}`;
const dirs: string[] = [];
afterAll(async () => {
  await server.stop(true);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };
const THEMES = ["none", "catppuccin-mocha", "thrifty-paper"];

function sb(storybook: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return parseConfig({
    storybook: { url, ...storybook },
    variants: [{ name: "desktop", viewport: { width: 200, height: 100 } }],
    stabilise: { timeoutMs: 1_500 },
    ...extra,
  });
}

async function names(storybook: Record<string, unknown>): Promise<string[]> {
  return (await storybookRoutes(sb(storybook).storybook!, [])).map((r) => r.name);
}

async function out(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-sb-"));
  dirs.push(dir);
  return dir;
}

describe("storybookRoutes", () => {
  test("story × globals, docs entries skipped, in index order", async () => {
    const config = sb({ globals: { theme: THEMES }, exclude: ["forms-input--*"] });
    const routes = await storybookRoutes(config.storybook!, []);
    expect(routes.map((r) => r.name)).toEqual([
      ...THEMES.map((t) => `ui-button-primary@theme=${t}`),
      ...THEMES.map((t) => `ui-button-page-heading@theme=${t}`),
    ]);
    expect(routes[1]).toMatchObject({
      path: "/iframe.html?id=ui-button--primary&viewMode=story&globals=theme:catppuccin-mocha",
      storybook: { origin: url },
    });
  });

  test("include and exclude are globs over the id or the title", async () => {
    expect(await names({ include: ["ui-button--*"] })).toEqual([
      "ui-button-primary",
      "ui-button-page-heading",
    ]);
    expect(await names({ include: ["Forms/*"], exclude: ["*--broken", "*--hangs"] })).toEqual([
      "forms-input-empty",
    ]);
    expect(await names({ exclude: ["UI/Button", "*--b*", "*--h*"] })).toEqual([
      "forms-input-empty",
    ]);
  });

  test("project masks and tags ride on every story route", async () => {
    const config = sb({ include: ["*--empty"] }, { tags: ["sb"], masks: [".clock"] });
    const [route] = await storybookRoutes(config.storybook!, []);
    expect(route).toMatchObject({ tags: ["sb"], masks: [".clock"] });
  });

  test("a name taken by a hand-written route, or nothing selected, is a config error", async () => {
    const config = sb({ include: ["*--empty"] });
    await expect(storybookRoutes(config.storybook!, ["forms-input-empty"])).rejects.toThrow(
      /storybook story "forms-input--empty" and a route in routes are both named "forms-input-empty"/,
    );
    await expect(storybookRoutes(sb({ include: ["nope"] }).storybook!, [])).rejects.toThrow(
      /no story in .* matches include\/exclude/,
    );
  });

  test("a story tagged pixelslash-once is one route with no globals; the others stay per theme", async () => {
    const overview = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          entries: Object.fromEntries([
            entry("ui-card--default", "UI/Card", "Default"),
            tagged("overview--all-themes", "Overview", "All Themes", ["dev", "pixelslash-once"]),
          ]),
        }),
    });
    try {
      const config = parseConfig({
        storybook: { url: `http://127.0.0.1:${overview.port}`, globals: { theme: THEMES } },
      });
      const routes = await storybookRoutes(config.storybook!, []);
      expect(routes.map((r) => r.name)).toEqual([
        ...THEMES.map((t) => `ui-card-default@theme=${t}`),
        "overview-all-themes",
      ]);
      expect(routes.at(-1)?.path).toBe("/iframe.html?id=overview--all-themes&viewMode=story");
    } finally {
      await overview.stop(true);
    }
  });

  test("two stories slugging to one name are a config error", async () => {
    const twin = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          entries: Object.fromEntries([entry("a--b", "A", "B c"), entry("a--b-c", "A", "B-c")]),
        }),
    });
    try {
      const config = parseConfig({ storybook: { url: `http://127.0.0.1:${twin.port}` } });
      await expect(storybookRoutes(config.storybook!, [])).rejects.toThrow(
        /story "a--b" and story "a--b-c"|story "a--b-c" and story "a--b"/,
      );
    } finally {
      await twin.stop(true);
    }
  });

  test.each([
    ["/index.json answers 404", 404, "not found", /answered HTTP 404/],
    ["is not JSON", 200, "<html>", /is not JSON/],
    ["is a Storybook 6 index", 200, '{"v":3,"stories":{}}', /needs Storybook 7 or later/],
  ])("an index.json that %s fails the capture", async (_, status, body, message) => {
    const bad = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(body, { status }),
    });
    try {
      const config = parseConfig({ storybook: { url: `http://127.0.0.1:${bad.port}` } });
      await expect(storybookRoutes(config.storybook!, [])).rejects.toThrow(message);
    } finally {
      await bad.stop(true);
    }
  });
});

describe("captureSnapshots with a storybook", () => {
  test("shoots every story × globals × variant, with the theme applied", async () => {
    const dir = await out();
    const config = sb({ globals: { theme: THEMES }, include: ["ui-button--primary"] });
    const { manifest } = await captureSnapshots(config, dir, pinned);
    expect(manifest.snapshots.map((s) => [s.name, s.path, s.file])).toEqual(
      THEMES.map((t) => [
        `ui-button-primary@theme=${t}`,
        `/iframe.html?id=ui-button--primary&viewMode=story&globals=theme:${t}`,
        `ui-button-primary@theme=${t}/desktop.png`,
      ]),
    );
    const onDisk: unknown = JSON.parse(await Bun.file(join(dir, "manifest.json")).text());
    expect(onDisk).toEqual(manifest);
    const corner = async (file: string) => {
      const png = PNG.sync.read(Buffer.from(await Bun.file(join(dir, file)).bytes()));
      return Array.from(png.data.subarray(png.data.length - 4));
    };
    expect(await corner(manifest.snapshots[0]!.file)).toEqual([255, 255, 255, 255]);
    expect(await corner(manifest.snapshots[1]!.file)).toEqual([0x1e, 0x1e, 0x2e, 255]);
    expect(await corner(manifest.snapshots[2]!.file)).toEqual([255, 0, 0, 255]);
  });

  test("hand-written routes and stories coexist; the storybook is the base when nothing else is", async () => {
    const dir = await out();
    const config = sb(
      { include: ["*--empty"] },
      { routes: [{ path: "/iframe.html?id=ui-button--primary&viewMode=story" }] },
    );
    const { manifest } = await captureSnapshots(config, dir, pinned);
    expect(manifest.snapshots.map((s) => s.name)).toEqual([
      "iframe.html-id-ui-button--primary-viewMode-story",
      "forms-input-empty",
    ]);
  });

  test("a story that errors fails the capture by name, with Storybook's message", async () => {
    const config = sb({ include: ["*--broken"] });
    await expect(captureSnapshots(config, await out(), pinned)).rejects.toThrow(
      /story forms-input-broken errored: Error: boom in forms-input--broken/,
    );
  });

  test("a story that never renders fails the capture by name inside the timeout", async () => {
    const config = sb({ include: ["*--hangs"] });
    const began = Date.now();
    await expect(captureSnapshots(config, await out(), pinned)).rejects.toThrow(
      /story forms-input-hangs did not render within 1500ms/,
    );
    expect(Date.now() - began).toBeLessThan(6_000);
  });
});
