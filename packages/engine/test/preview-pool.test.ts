import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { captureInto } from "../src/capture-into.ts";
import { identity } from "../src/manifest.ts";
import { openCaptureSession, recapture } from "../src/snapshot.ts";

/**
 * Reused preview pages on a real browser (PS-445). The preview here is Storybook's iframe reduced
 * to what capture reads: the channel (`setCurrentStory` in, render phases and failures out), the
 * body classes and `#storybook-root`. One story paints `<html>` and adds a portal to `<body>`, which
 * a switch must undo; one throws only when switched to in place.
 */

const entry = (id: string) => [
  id,
  { type: "story", id, title: "UI/X", name: id, importPath: "./x.stories.tsx", tags: [] },
];
const IDS = ["ui-x--one", "ui-x--paints", "ui-x--two", "ui-x--reuse-throws", "ui-x--three"];
const INDEX = { v: 5, entries: Object.fromEntries(IDS.map(entry)) };

const IFRAME = `<!doctype html><body class="sb-show-preparing" style="margin:0">
<div id="storybook-root"></div><pre id="error-message"></pre><script>
const listeners = {};
const fire = (ev, p) => (listeners[ev] ?? []).forEach((f) => f(p));
window.__STORYBOOK_ADDONS_CHANNEL__ = {
  on: (ev, f) => (listeners[ev] ??= []).push(f),
  emit: (ev, p) => ev === "setCurrentStory" && render(p.storyId, true),
};
function render(id, switched) {
  fire("storyRenderPhaseChanged", { storyId: id, newPhase: "loading" });
  const root = document.getElementById("storybook-root");
  root.innerHTML = "";
  if (switched && id.endsWith("--reuse-throws")) {
    fire("storyThrewException", { message: "not on a used page" });
    return;
  }
  if (id.endsWith("--paints")) {
    document.documentElement.setAttribute("style", "background:#ff0000");
    const portal = document.createElement("div");
    portal.style.cssText = "position:absolute;top:0;left:0;width:200px;height:100px;background:#00ff00";
    document.body.appendChild(portal);
  }
  root.innerHTML = "<div style='height:40px;width:120px;font:12px sans-serif'>" + id + "</div>";
  document.body.className = "sb-show-main";
  fire("storyRenderPhaseChanged", { storyId: id, newPhase: "rendering" });
  fire("storyRenderPhaseChanged", { storyId: id, newPhase: "completing" });
}
render(new URLSearchParams(location.search).get("id"), false);
</script>`;

let loads = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/index.json") return Response.json(INDEX);
    if (pathname === "/iframe.html") {
      loads++;
      return new Response(IFRAME, { headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const dirs: string[] = [];
afterAll(async () => {
  await server.stop(true);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };
const config = parseConfig({
  storybook: { url: `http://127.0.0.1:${server.port}` },
  variants: [{ name: "desktop", viewport: { width: 200, height: 100 } }],
  stabilise: { timeoutMs: 1_500 },
});

async function out(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-pool-"));
  dirs.push(dir);
  return dir;
}

/** Every shot's PNG by name, from a capture into `dir`. */
async function pngs(dir: string, files: { name: string; file: string }[]) {
  const all = new Map<string, Buffer>();
  for (const { name, file } of files)
    all.set(name, Buffer.from(await Bun.file(join(dir, file)).bytes()));
  return all;
}

describe("a story may be shot on a reused preview page, only when the capture asks (PS-445)", () => {
  test("with reuse, one worker loads the preview once and switches the rest in place", async () => {
    const session = await openCaptureSession(config, pinned);
    try {
      const freshDir = await out();
      loads = 0;
      const fresh = await captureInto(session, freshDir, 1);
      expect(loads).toBe(IDS.length);
      expect(fresh.reused).toBeUndefined();

      const reusedDir = await out();
      loads = 0;
      const reused = await captureInto(session, reusedDir, 1, { reuse: true });
      // The first story's load; the fresh page for the story that throws on a used page; and a new
      // pooled page after it, since a page a story failed on is closed, not put back.
      expect(loads).toBe(3);
      const names = reused.manifest.snapshots.map((e) => e.name);
      // Only a story switched to in place is a reused page's shot; a load, on a slot's new page or
      // on the fresh page after a failure, is a fresh page's.
      expect([...reused.reused!].toSorted()).toEqual(
        reused.manifest.snapshots
          .filter((e) => /paints|two/.test(e.name))
          .map(identity)
          .toSorted(),
      );
      expect(names).toEqual(fresh.manifest.snapshots.map((e) => e.name));

      // The page is put back between stories: what `paints` left on <html> and <body> is gone.
      const a = await pngs(freshDir, fresh.manifest.snapshots);
      const b = await pngs(reusedDir, reused.manifest.snapshots);
      expect(b).toEqual(a);
    } finally {
      await session.close();
    }
  }, 60_000);

  test("a re-capture is always on a fresh page, even in a session that reused pages", async () => {
    const session = await openCaptureSession(config, pinned);
    try {
      const { manifest } = await captureInto(session, await out(), 1, { reuse: true });
      loads = 0;
      const shots = await Promise.all(manifest.snapshots.map((e) => recapture(session, e)));
      expect(loads).toBe(IDS.length);
      for (const shot of shots) expect(shot?.reused).toBeUndefined();
    } finally {
      await session.close();
    }
  }, 60_000);
});
