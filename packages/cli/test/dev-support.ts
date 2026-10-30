import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll } from "vitest";
import { solidPng } from "./support.ts";
import { gitRepo } from "./upload-support.ts";

/** `pixelslash dev`'s fixtures (ob 1740, 1741), shared by its CLI and MCP tests. */

const servers: Array<{ stop(force?: boolean): unknown }> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

/** A git repo with a config whose one route is `page.html` in the repo, read on every request. */
export async function project(width = 400) {
  const cwd = await gitRepo();
  const file = join(cwd, "page.html");
  await writeFile(file, `<body style="margin:0;background:#fff"><p>one</p></body>`);
  const page = Bun.serve({
    port: 0,
    fetch: async () =>
      new Response(await readFile(file, "utf8"), { headers: { "content-type": "text/html" } }),
  });
  servers.push(page);
  await Bun.write(
    join(cwd, "pixelslash.config.json"),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${page.port}`,
      routes: ["/"],
      variants: [{ name: "small", viewport: { width, height: 300 } }],
    }),
  );
  return { cwd, file };
}

export async function until<T>(get: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await get();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

export const FIGMA = "https://www.figma.com/design/AbC123/Shop?node-id=1-2";

/** `project()` with `features.index`: a spec, a wide repo PNG, and a Figma frame. */
export async function featureProject(width = 400) {
  const p = await project(width);
  await writeFile(join(p.cwd, "cart.md"), "# Cart\nThe total sits under the list.");
  await writeFile(join(p.cwd, "cart.png"), solidPng(2048, 100, [0, 0, 200, 255]));
  const config = JSON.parse(await readFile(join(p.cwd, "pixelslash.config.json"), "utf8"));
  config.features = { index: { spec: "cart.md", refs: ["cart.png", FIGMA] } };
  await writeFile(join(p.cwd, "pixelslash.config.json"), JSON.stringify(config));
  return p;
}
