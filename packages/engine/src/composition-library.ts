import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CompositionConfig, CustomDeclared } from "./config-composition.ts";
import { UsageError } from "./errors.ts";

/**
 * How a library element is told from the app's (ob 1850): the library's built JS is read for its
 * string literals, and each literal made only of class-like tokens is a chunk (`cx(SHAPE,
 * focusRing, ...)` joins such chunks). An element's classes that some whole chunk covers are the
 * library's; the rest are the app's.
 */

/** What the walk compares the DOM with, read once per capture from the installed package. */
export type CompositionLibrary = {
  name: string;
  /** Each class-string literal in the library's JS, as its tokens. */
  chunks: string[][];
  /** The inline style properties (kebab-case) the library's JS sets itself. */
  styleProps: string[];
  custom: CustomDeclared[];
};

const CLASS_TOKEN = /^[\w:\-[\]/.%!#(),=&>~+*@]+$/;

/** A scan of JS source for its string literals; `holes` is the brace depth of each open `${`. */
type Scan = { src: string; out: string[]; holes: number[]; depth: number };

/** Past a `//` or `/*` comment starting at `i`. */
function skipComment(src: string, i: number): number {
  const block = src[i + 1] === "*";
  const end = src.indexOf(block ? "*/" : "\n", i + 2);
  if (end < 0) return src.length;
  return block ? end + 2 : end;
}

/** A '...' or "..." literal starting at `i`; returns the index past its closing quote. */
function quoted(scan: Scan, i: number): number {
  const { src } = scan;
  const q = src[i];
  let s = "";
  let j = i + 1;
  for (; j < src.length && src[j] !== q; j++) {
    if (src[j] === "\\") j++;
    s += src[j] ?? "";
  }
  scan.out.push(s);
  return j + 1;
}

const holeAt = (src: string, j: number) => src[j] === "$" && src[j + 1] === "{";

/** The class tokens of a template literal's static part: a token running into a hole is only part of a class. */
function wholeTokens(s: string, resumed: boolean, hole: boolean): string {
  let tokens = s.split(/\s+/);
  if (resumed && !/^\s/.test(s)) tokens = tokens.slice(1);
  if (hole && !/\s$/.test(s)) tokens = tokens.slice(0, -1);
  return tokens.join(" ");
}

/**
 * The static part of a template literal from `start` to its next `` ` `` or `${`; `resumed` is a
 * part that follows a hole.
 */
function templatePart(scan: Scan, start: number, resumed: boolean): number {
  const { src } = scan;
  let s = "";
  let j = start;
  for (; j < src.length && src[j] !== "`" && !holeAt(src, j); j++) {
    if (src[j] === "\\") j++;
    s += src[j] ?? "";
  }
  const hole = holeAt(src, j);
  scan.out.push(wholeTokens(s, resumed, hole));
  if (!hole) return j + 1;
  scan.holes.push(scan.depth);
  return j + 2;
}

const commentAt = (src: string, i: number) =>
  src[i] === "/" && (src[i + 1] === "/" || src[i + 1] === "*");

/** One step of the scan at `i`; returns where the next step starts. */
function step(scan: Scan, i: number): number {
  const c = scan.src[i];
  if (commentAt(scan.src, i)) return skipComment(scan.src, i);
  if (c === '"' || c === "'") return quoted(scan, i);
  if (c === "`") return templatePart(scan, i + 1, false);
  if (c === "}" && scan.holes.at(-1) === scan.depth) {
    scan.holes.pop();
    return templatePart(scan, i + 1, true);
  }
  if (c === "{") scan.depth++;
  if (c === "}") scan.depth--;
  return i + 1;
}

/**
 * Every string literal in `src`, comments skipped; a template literal gives its static parts.
 * Regex literals are not understood; a built library rarely has one with a quote in it.
 */
export function stringLiterals(src: string): string[] {
  const scan: Scan = { src, out: [], holes: [], depth: 0 };
  for (let i = 0; i < src.length;) i = step(scan, i);
  return scan.out;
}

/** The literals made only of class-like tokens, as token lists, one per distinct set. */
export function classChunks(literals: string[]): string[][] {
  const seen = new Map<string, string[]>();
  for (const lit of literals) {
    const tokens = lit.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (!tokens.every((t) => CLASS_TOKEN.test(t) && /[a-z]/i.test(t))) continue;
    const set = [...new Set(tokens)].toSorted();
    seen.set(set.join(" "), set);
  }
  return [...seen.values()];
}

const kebab = (prop: string) => prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The inline style properties a library's JS sets: `style: { backgroundColor }`, `.style.colorScheme =`, `setProperty("x")`. */
export function styleProps(src: string): string[] {
  const props = new Set<string>();
  // `{ backgroundColor, color: tone }`: each entry's key, shorthand or not.
  const entries = [...src.matchAll(/style\s*:\s*\{([^}]*)\}/g)].flatMap((m) =>
    (m[1] ?? "").split(","),
  );
  for (const key of entries.map((e) => e.split(":")[0]?.trim() ?? ""))
    if (/^[A-Za-z]+$/.test(key)) props.add(kebab(key));
  for (const m of src.matchAll(/\.style\.([A-Za-z]+)\s*=/g)) props.add(kebab(m[1] ?? ""));
  for (const m of src.matchAll(/setProperty\(\s*["']([a-z-]+)["']/g)) props.add(m[1] ?? "");
  props.delete("");
  return [...props].toSorted();
}

/** The library's package directory: `node_modules/<library>` in `from` or the nearest directory above it. */
function packageDir(library: string, from: string): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", library);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir)
      throw new UsageError(
        `config: composition.library ${library} is not installed (no node_modules/${library} at or above ${from})`,
      );
  }
}

/** Read the installed library's JS (its own files, not its dependencies) into what the walk needs. */
export async function loadLibrary(
  c: CompositionConfig,
  cwd: string = process.cwd(),
): Promise<CompositionLibrary> {
  const dir = packageDir(c.library, c.from ?? cwd);
  const literals: string[] = [];
  const props = new Set<string>();
  const glob = new Bun.Glob("**/*.{js,mjs,cjs,jsx}");
  for await (const file of glob.scan({ cwd: dir, followSymlinks: false })) {
    if (file.split("/").includes("node_modules")) continue;
    const src = await Bun.file(join(dir, file)).text();
    literals.push(...stringLiterals(src));
    for (const p of styleProps(src)) props.add(p);
  }
  const chunks = classChunks(literals);
  if (chunks.length === 0)
    throw new UsageError(
      `config: composition.library ${c.library} has no class strings in its JS (${dir})`,
    );
  return { name: c.name, chunks, styleProps: [...props].toSorted(), custom: c.custom };
}
