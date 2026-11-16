/**
 * Checks docs/personas/personas.json and keeps the table in docs/personas/README.md in step with it.
 *
 *   bun scripts/personas.ts          rewrite the table between the markers
 *   bun scripts/personas.ts --check  fail if the file is invalid or the table is stale
 *
 * The JSON is the source of truth. Edit, add or remove a persona there, then run this once. The
 * `scripts` project's test runs the check, so a stale table fails the gate.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PERSONAS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/personas");
const START = "<!-- personas:start -->";
const END = "<!-- personas:end -->";
/** Exactly five, an odd number, so a vote between personas always has a winner. */
const COUNT = 5;
const FOCUS_KEYS = ["review", "docs", "cli"] as const;
const DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`, "u");
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export type Persona = {
  id: string;
  name: string;
  group: string;
  model: string;
  profile: string;
  focus: Record<(typeof FOCUS_KEYS)[number], string>;
};
export type PersonasFile = {
  groups: Record<string, string>;
  models: string[];
  personas: Persona[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The text fields one persona's row prints, with names for the error message. */
function printed(p: Obj, groups: Obj): [string, unknown][] {
  const focus = isObj(p["focus"]) ? p["focus"] : {};
  return [
    ["name", p["name"]],
    ["group label", groups[str(p["group"])]],
    ["model", p["model"]],
    ["profile", p["profile"]],
    ...FOCUS_KEYS.map((k): [string, unknown] => [`focus.${k}`, focus[k]]),
  ];
}

function checkFocus(at: string, focus: unknown): string[] {
  const f = isObj(focus) ? focus : {};
  const keys: readonly string[] = FOCUS_KEYS;
  return [
    ...FOCUS_KEYS.filter((k) => !isText(f[k])).map((k) => `${at}: focus.${k} is empty`),
    ...Object.keys(f)
      .filter((k) => !keys.includes(k))
      .map((k) => `${at}: focus.${k} is not one of ${FOCUS_KEYS.join(", ")}`),
  ];
}

function checkPersona(p: Obj, groups: Obj, models: unknown[]): string[] {
  const at = `persona ${str(p["id"]) || "?"}`;
  const errs: string[] = [];
  if (!KEBAB.test(str(p["id"]))) errs.push(`${at}: id must be lower-case kebab`);
  if (!isText(p["name"])) errs.push(`${at}: name is empty`);
  if (!isText(p["profile"])) errs.push(`${at}: profile is empty`);
  if (!Object.hasOwn(groups, str(p["group"])))
    errs.push(`${at}: group "${str(p["group"])}" is not in groups`);
  if (!models.includes(p["model"])) errs.push(`${at}: model "${str(p["model"])}" is not in models`);
  errs.push(...checkFocus(at, p["focus"]));
  for (const [field, v] of printed(p, groups))
    if (typeof v === "string" && /[|\r\n]/.test(v))
      errs.push(`${at}: ${field} has a "|" or a line break, which breaks the table`);
  return errs;
}

function validate(f: unknown): string[] {
  if (!isObj(f)) return ["the file is not a JSON object"];
  const { groups, models, personas } = f;
  if (!isObj(groups)) return ["groups must be an object"];
  if (!Array.isArray(models)) return ["models must be an array"];
  if (!Array.isArray(personas)) return ["personas must be an array"];
  const errs: string[] = [];
  if (personas.length !== COUNT)
    errs.push(`need exactly ${COUNT} personas, found ${personas.length}`);
  const seen = new Set<string>();
  for (const p of personas) {
    if (!isObj(p)) {
      errs.push("a persona is not an object");
      continue;
    }
    const id = str(p["id"]);
    if (seen.has(id)) errs.push(`persona ${id}: duplicate id`);
    seen.add(id);
    errs.push(...checkPersona(p, groups, models));
  }
  if (DASH.test(JSON.stringify(f))) errs.push("an em or en dash is not allowed");
  return errs;
}

/** True when `f` is valid; otherwise false, with the reasons pushed onto `errors`. */
function isPersonasFile(f: unknown, errors: string[]): f is PersonasFile {
  errors.push(...validate(f));
  return errors.length === 0;
}

/** The Markdown table for the README, one row per persona. */
export function renderTable(f: PersonasFile): string {
  const rows = f.personas.map((p) => {
    const cells = [
      p.name,
      f.groups[p.group],
      p.model,
      p.profile,
      ...FOCUS_KEYS.map((k) => p.focus[k]),
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [
    `| Persona | Group | Model | Who | ${FOCUS_KEYS.map((k) => `Looks for (${k})`).join(" | ")} |`,
    `| --- | --- | --- | --- | ${FOCUS_KEYS.map(() => "---").join(" | ")} |`,
    ...rows,
  ].join("\n");
}

/** Reads and validates personas.json; the file is only returned when it has no errors. */
export function readPersonas(dir: string): { errors: string[]; file?: PersonasFile } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, "personas.json"), "utf8"));
  } catch (e) {
    return { errors: [`personas.json: cannot be read as JSON: ${message(e)}`] };
  }
  const errors: string[] = [];
  if (!isPersonasFile(raw, errors)) return { errors: errors.map((e) => `personas.json: ${e}`) };
  return { errors, file: raw };
}

/** The README as it should be: the current one with the table between the markers rewritten. */
function rendered(dir: string): { errors: string[]; readme?: string; next?: string } {
  const { errors, file } = readPersonas(dir);
  if (!file) return { errors };
  let readme: string;
  try {
    readme = readFileSync(join(dir, "README.md"), "utf8");
  } catch (e) {
    return { errors: [`README.md: cannot be read: ${message(e)}`] };
  }
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) return { errors: [`README.md: needs ${START} and ${END} markers`] };
  const next = `${readme.slice(0, a + START.length)}\n${renderTable(file)}\n${readme.slice(b)}`;
  return { errors: [], readme, next };
}

/** Rewrites the README's table; returns the errors that stopped it, empty when written. */
function write(dir: string = PERSONAS_DIR): string[] {
  const { errors, next } = rendered(dir);
  if (errors.length || next === undefined) return errors;
  writeFileSync(join(dir, "README.md"), next);
  return [];
}

/** The problems with the personas in `dir`; empty when the file is valid and the table current. */
export function checkPersonas(dir: string = PERSONAS_DIR): string[] {
  const { errors, readme, next } = rendered(dir);
  if (errors.length) return errors;
  return next === readme ? [] : ["README.md: the table is stale: run bun scripts/personas.ts"];
}

if (import.meta.main) {
  const errors = process.argv.includes("--check") ? checkPersonas() : write();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log(
    process.argv.includes("--check")
      ? `ok: ${COUNT} personas`
      : `wrote the table for ${COUNT} personas`,
  );
}
