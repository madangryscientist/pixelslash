/** The capture-stage fixture pages (ob 1489) and the small server that hosts them. */
import { join } from "node:path";
import { BENCH_DIR } from "./corpus.ts";

export const CAPTURE_DIR = join(BENCH_DIR, "fixtures-capture");

export type CapturePage = {
  /** Route name and file stem: `/<name>.html`. */
  name: string;
  /** What changes between two loads of the page if nothing stabilises it. */
  noise: string;
};

export const CAPTURE_PAGES: CapturePage[] = [
  { name: "css-animation", noise: "infinite spinner and pulse, plus a slide-in, on CSS keyframes" },
  { name: "shimmer", noise: "skeleton gradient sweeping on an infinite keyframe" },
  { name: "caret", noise: "blinking caret in a focused input and textarea" },
  { name: "clock", noise: "Date.now() text redrawn every 50 ms and a relative time" },
  {
    name: "carousel",
    noise: "slides auto-advancing on a 200 ms setInterval, first tick after a random wait",
  },
  { name: "lazy-image", noise: "a slow image above the fold and a loading=lazy one below it" },
];

function svg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160"><rect width="480" height="160" fill="#${color}"/><circle cx="240" cy="80" r="40" fill="#fff"/></svg>`;
}

/**
 * Serves the pages from `bench/fixtures-capture/`, and `/slow.svg?ms=&color=`: an image held for `ms`
 * before it answers, so an image that has not arrived yet is a real state a capture can land in.
 * Binds the loopback only; the pinned image reaches it with `--network host`.
 */
export function servePages(): { origin: string; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/slow.svg") {
        await Bun.sleep(Number(url.searchParams.get("ms") ?? 0));
        const color = (url.searchParams.get("color") ?? "888888").replace(/[^0-9a-f]/gi, "");
        return new Response(svg(color), { headers: { "content-type": "image/svg+xml" } });
      }
      const page = CAPTURE_PAGES.find((p) => url.pathname === `/${p.name}.html`);
      if (!page) return new Response("not found", { status: 404 });
      return new Response(Bun.file(join(CAPTURE_DIR, `${page.name}.html`)));
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}
