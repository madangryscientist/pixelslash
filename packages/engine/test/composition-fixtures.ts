import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in design-system library: `node_modules/@acme/ui` with built JS the way a component
 * library ships it (class strings joined by a `cx`, a template literal with a hole, one inline style).
 */
export const LIBRARY_JS = `// A \`Button\`: "inline-flex" and friends; this comment's strings are not classes.
/* The card's shadow is "shadow-lg" in v2. */
import { cx } from "./cx.js";
const SHAPE = "inline-flex items-center rounded px-3";
const focusRing = 'focus:ring-2';
export const Button = (p) => ({ type: "button", className: cx(SHAPE, focusRing, p.className) });
export const Card = (p) => ({ className: \`card p-4 \${p.wide ? "w-full" : "w-80"} shadow\` });
export const Swatch = (p) => ({ className: "swatch rounded", style: { backgroundColor: p.colour } });
export const Layer = (p) => ({ className: cx("relative", p.className) });
`;

/** A project dir with the library installed; the caller removes it. */
export async function libraryProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-composition-"));
  const pkg = join(dir, "node_modules", "@acme", "ui");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await Bun.write(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@acme/ui", version: "1.0.0" }),
  );
  await Bun.write(join(pkg, "dist", "index.js"), LIBRARY_JS);
  await Bun.write(
    join(pkg, "dist", "cx.js"),
    "export const cx = (...c) => c.filter(Boolean).join(' ');\n",
  );
  // A dependency of the library: its strings are not the library's.
  await mkdir(join(pkg, "node_modules", "dep"), { recursive: true });
  await Bun.write(join(pkg, "node_modules", "dep", "index.js"), 'export const x = "mt-7";\n');
  return dir;
}

/** A page; `css` is a stylesheet, which the walk does not read (it places the fixtures' boxes). */
const page = (body: string, css = "") =>
  `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif}${css}</style></head><body>${body}</body></html>`;

const at = (sel: string, [x, y, w, h]: [number, number, number, number]) =>
  `${sel}{position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;margin:0}`;

/** Fixture pages: a library-only page, then one per kind of finding. */
export const PAGES = {
  clean: page(
    `<main><button class="inline-flex items-center rounded px-3 focus:ring-2">Save</button>
     <section class="card p-4 w-80 shadow">Card</section>
     <span class="swatch rounded" style="background-color: red">S</span><p>Plain text</p></main>`,
  ),
  inline: page(
    `<main><p>One</p><p style="color: rgb(200, 0, 0)">Two</p></main>`,
    at("main p:nth-of-type(2)", [10, 50, 200, 30]),
  ),
  stray: page(
    `<button id="go" class="inline-flex items-center rounded px-3 focus:ring-2 mt-7">Go</button>`,
    at("#go", [20, 40, 100, 24]),
  ),
  handRolled: page(`<div class="banner glow">Hi</div>`, at(".banner", [30, 60, 300, 40])),
  oneClass: page(
    `<div id="hero" class="relative mt-7" style="background-color: blue">Hi</div>`,
    at("#hero", [0, 0, 100, 50]),
  ),
  marked: page(
    `<div data-pixelslash-custom="the brand mark is drawn by hand" class="logo spin"><span class="inner" style="color: red">x</span></div>`,
    at(".logo", [5, 5, 64, 64]),
  ),
};
