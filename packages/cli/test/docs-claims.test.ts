import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { UsageError } from "@hackcove/pixelslash-engine";
import { parseDevArgs } from "../src/dev.ts";

/*
 * Two claims the docs make about the CLI, held against the code (PS-387): which commands take
 * `--only`, and which environment variables the packages read. The prose is edited by hand, so
 * these fail when it stops matching the source.
 */
const ROOT = join(import.meta.dirname, "../../..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const CLI_MD = read("docs/cli.md");
const byName = (a: string, b: string): number => a.localeCompare(b);

/** Every `.ts` file under `dir`, skipping what is not source (tests, build output, dependencies). */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "test"].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".config.ts") ? [path] : [];
  });
}

describe("--only", () => {
  const cliSrc = join(ROOT, "packages/cli/src");
  // A command's file is named after it (capture.ts, check.ts), and only a parser that calls takeOnly takes the flag.
  const parsers = readdirSync(cliSrc)
    .filter(
      (file) => file !== "args.ts" && /\btakeOnly\(/.test(readFileSync(join(cliSrc, file), "utf8")),
    )
    .map((file) => file.replace(/\.ts$/, ""))
    .toSorted(byName);

  test("the parser takes it on capture and check, and not on dev", () => {
    expect(parsers).toEqual(["capture", "check"]);
    expect(() => parseDevArgs(["--only", "home"])).toThrow(UsageError);
  });

  test("the FAQ names exactly the commands whose parser takes it", () => {
    const line = read("docs/help/faq.md")
      .split("\n")
      .find((l) => l.startsWith("Use `--only NAME` on "));
    expect(line).toBeDefined();
    const named = [
      ...(line ?? "").split(". ")[0]!.matchAll(/`(capture|check|dev|compare|upload)`/g),
    ]
      .map((m) => m[1] ?? "")
      .toSorted(byName);
    expect(named).toEqual(parsers);
  });

  test("a synopsis in cli.md lists it for those commands and not for dev", () => {
    const lines = CLI_MD.split("\n");
    const synopses = (command: string) =>
      lines.filter(
        (l) =>
          new RegExp(`(^|\\s)(pixelslash )?${command} \\[`).test(l) &&
          l.includes("--config") &&
          !l.includes("--upload"),
      );
    for (const command of parsers) {
      const found = synopses(command);
      expect(found.length).toBeGreaterThan(0);
      expect(found.filter((l) => !l.includes("--only NAME"))).toEqual([]);
    }
    const dev = lines.filter((l) => l.startsWith("pixelslash dev ["));
    expect(dev.length).toBeGreaterThan(0);
    for (const l of dev) expect(l).not.toContain("--only");
  });
});

describe("the environment variables section", () => {
  /** Names that only appear in generated text or messages, never read. Each with its reason. */
  const NOT_READ: Record<string, string> = {};

  const NAME = "[A-Z][A-Z0-9_]*";
  const READS = [
    new RegExp(`process\\.env\\.(${NAME})\\b`, "g"),
    new RegExp(`process\\.env\\["(${NAME})"\\]`, "g"),
    new RegExp(`Bun\\.env\\.(${NAME})\\b`, "g"),
    new RegExp(`\\benv\\.(${NAME})\\b`, "g"),
    new RegExp(`\\benv\\["(${NAME})"\\]`, "g"),
    // A name held in a constant and used as an env key (SENTRY_DSN_VAR, OPENCODE_MODEL_ENV).
    /"(PIXELSLASH_[A-Z0-9_]+)"/g,
  ];

  const files = readdirSync(join(ROOT, "packages")).flatMap((pkg) =>
    sources(join(ROOT, "packages", pkg, "src")),
  );
  const readNames = new Set(
    files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return READS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1] ?? ""));
    }),
  );
  for (const name of Object.keys(NOT_READ)) readNames.delete(name);

  const start = CLI_MD.indexOf("\n## Environment variables\n");
  const end = CLI_MD.indexOf("\n## ", start + 1);
  const section = start === -1 ? "" : CLI_MD.slice(start, end);
  const listed = new Set(
    [...section.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((m) => m[1] ?? ""),
  );

  test("the scan finds the variables it is known to", () => {
    const known = ["PIXELSLASH_TOKEN", "PIXELSLASH_SENTRY_DSN", "PIXELSLASH_OPENCODE_MODEL"];
    expect(known.filter((name) => !readNames.has(name))).toEqual([]);
    expect(readNames.size).toBeGreaterThanOrEqual(12);
  });

  test("lists every variable read in packages/*/src", () => {
    expect(section).not.toBe("");
    expect([...readNames].filter((name) => !listed.has(name)).toSorted(byName)).toEqual([]);
  });

  test("lists no variable that nothing reads", () => {
    expect([...listed].filter((name) => !readNames.has(name)).toSorted(byName)).toEqual([]);
  });
});
