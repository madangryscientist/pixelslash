import type { Mask } from "./config-areas.ts";
import type { Fail } from "./diff-options.ts";
import { isHttpUrl } from "./routes.ts";

/** The `storybook` source: every story in `<url>/index.json` × every combination of `globals`. */
export type StorybookConfig = {
  url: string;
  /** Global name → the values to shoot it at; the cartesian product of them is one snapshot per story each. */
  globals: Record<string, string[]>;
  /** Globs over a story's id or title; a story is kept when it matches any include and no exclude. */
  include: string[];
  exclude: string[];
  /** The project-wide masks and tags, which every story route carries like a hand-written one. */
  masks: Mask[];
  tags: string[];
};

const KEYS = ["url", "globals", "include", "exclude"];

function text(v: unknown, where: string, fail: Fail): string {
  if (typeof v !== "string" || v === "") fail(where, "must be a non-empty string");
  return v;
}

function textList(v: unknown, where: string, fail: Fail): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(where, "must be an array of strings");
  return v.map((s, i) => text(s, `${where}[${i}]`, fail));
}

/** A global's name or value: it goes between `:` and `;` in the iframe URL, so neither may hold them. */
function globalText(v: unknown, where: string, fail: Fail): string {
  const value = text(v, where, fail);
  if (/[:;]/.test(value)) fail(where, "must not contain : or ;");
  return value;
}

function parseGlobals(v: unknown, fail: Fail): Record<string, string[]> {
  const raw = v ?? {};
  if (typeof raw !== "object" || Array.isArray(raw))
    fail("storybook.globals", "must be an object of name → list of values");
  const globals: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(raw)) {
    globalText(name, `storybook.globals key "${name}"`, fail);
    if (!Array.isArray(values) || values.length === 0)
      fail(`storybook.globals.${name}`, "must be a non-empty array of strings");
    const listed = values.map((x, i) => globalText(x, `storybook.globals.${name}[${i}]`, fail));
    if (new Set(listed).size !== listed.length)
      fail(`storybook.globals.${name}`, "lists a value twice");
    globals[name] = listed;
  }
  return globals;
}

/** Validate the `storybook` block and fill its defaults; the project-wide masks and tags ride along. */
export function parseStorybook(
  v: unknown,
  global: { masks: Mask[]; tags: string[] },
  fail: Fail,
): StorybookConfig | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v))
    fail("storybook", "must be { url, globals?, include?, exclude? }");
  const raw: Record<string, unknown> = { ...v };
  for (const k of Object.keys(raw)) {
    if (!KEYS.includes(k)) fail(`storybook.${k}`, `is not a storybook option (${KEYS.join(", ")})`);
  }
  const url = text(raw.url, "storybook.url", fail);
  if (!isHttpUrl(url)) fail("storybook.url", "must be an http(s) URL");
  const include = textList(raw.include, "storybook.include", fail);
  return {
    url,
    globals: parseGlobals(raw.globals, fail),
    include: include.length === 0 ? ["**"] : include,
    exclude: textList(raw.exclude, "storybook.exclude", fail),
    ...global,
  };
}

/** A Storybook-only config has no app of its own: the Storybook is the base. */
export function baseUrlOf(raw: unknown, sb: StorybookConfig | undefined, fail: Fail): string {
  const baseUrl = raw === undefined && sb ? sb.url : text(raw, "baseUrl", fail);
  if (!URL.canParse(baseUrl)) fail("baseUrl", "must be a URL");
  return baseUrl;
}
