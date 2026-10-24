import type { Fail } from "./diff-options.ts";

/** An element the project styles on purpose, outside the library: listed with its reason, never a gap. */
export type CustomDeclared = { selector: string; reason: string };

/**
 * The config's `composition` (ob 1850): the project builds its pages from one design-system
 * library's components, so every element styled outside them is reported at capture.
 */
export type CompositionConfig = {
  /** The library's npm package name, e.g. `@hackcove/ui`. */
  library: string;
  /** What the report calls the library: "<name> gaps". Default: the package name. */
  name: string;
  /** Special cases by selector, beside the `data-pixelslash-custom` marker. */
  custom: CustomDeclared[];
  /** Where the library's package is looked for, walking up; `loadConfig` sets the config's directory. */
  from: string | undefined;
};

const KEYS = new Set(["library", "name", "custom"]);

function text(v: unknown, where: string, fail: Fail): string {
  if (typeof v !== "string" || v.trim() === "") fail(where, "must be a non-empty string");
  return v.trim();
}

function declared(v: unknown, where: string, fail: Fail): CustomDeclared {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    fail(where, "must be { selector, reason }");
  return {
    selector: text(Reflect.get(v, "selector"), `${where}.selector`, fail),
    reason: text(Reflect.get(v, "reason"), `${where}.reason`, fail),
  };
}

/** The config's `composition: { library, name?, custom? }`; `undefined` when absent. */
export function parseComposition(v: unknown, fail: Fail): CompositionConfig | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v))
    fail("composition", "must be { library, name?, custom? }");
  for (const k of Object.keys(v))
    if (!KEYS.has(k))
      fail(`composition.${k}`, "is not a composition option (library, name, custom)");
  const library = text(Reflect.get(v, "library"), "composition.library", fail);
  const name = Reflect.get(v, "name");
  const custom = Reflect.get(v, "custom") ?? [];
  if (!Array.isArray(custom))
    fail("composition.custom", "must be an array of { selector, reason }");
  return {
    library,
    name: name === undefined ? library : text(name, "composition.name", fail),
    custom: custom.map((c, i) => declared(c, `composition.custom[${i}]`, fail)),
    from: undefined,
  };
}
