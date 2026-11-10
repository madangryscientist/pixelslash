import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { COMMAND_SUMMARY, buildCommandIndex, commandIndexMarkdown, flagsOf } from "./cli-index.ts";
import { CLI_SPLIT } from "./cli-split.ts";
import { findPage } from "./docs-map.ts";

const RUN_TS = readFileSync(
  join(import.meta.dirname, "../../../../packages/cli/src/run.ts"),
  "utf8",
);

/** The keys of `COMMANDS` in the CLI's own source: the commands the binary has. */
function cliCommands(): string[] {
  const start = RUN_TS.indexOf("const COMMANDS");
  const open = RUN_TS.indexOf("= {", start);
  const end = RUN_TS.indexOf("\n};", open);
  const body = RUN_TS.slice(open + 3, end);
  return [...body.matchAll(/^ {2}("?)([a-z][a-z-]*)\1: /gm)].map((m) => m[2] ?? "");
}

const INDEX = buildCommandIndex(CLI_SPLIT.pages);

describe("the command index", () => {
  test("reads the commands from the CLI's own table", () => {
    expect(cliCommands().length).toBeGreaterThan(15);
  });

  test("lists every command the CLI has, and none it does not", () => {
    expect(INDEX.map((entry) => entry.command).toSorted()).toEqual(cliCommands().toSorted());
  });

  test("every command has a one-line summary, and none is for a command the CLI lacks", () => {
    expect(Object.keys(COMMAND_SUMMARY).toSorted()).toEqual(cliCommands().toSorted());
    for (const summary of Object.values(COMMAND_SUMMARY)) expect(summary).toMatch(/\.$/);
  });

  test("each command's owner is a real page that shows its synopsis", () => {
    const wrong = INDEX.filter((entry) => {
      // `compare` is the bare `pixelslash --live …` form: it has no word after `pixelslash`.
      const shown = entry.command === "compare" ? "pixelslash" : `pixelslash ${entry.command}`;
      const tokens = JSON.stringify(CLI_SPLIT.pages.get(entry.page));
      return findPage(entry.page) === undefined || !tokens.includes(shown);
    }).map((entry) => `${entry.command} on ${entry.page}`);
    expect(wrong).toEqual([]);
  });

  test("every flag starts with -- and says what it does", () => {
    const flags = INDEX.flatMap((entry) =>
      entry.flags.map((flag) => ({ ...flag, command: entry.command })),
    );
    expect(flags.length).toBeGreaterThan(40);
    const bad = flags
      .filter(({ flag, what }) => !/^--[a-z]/.test(flag) || what === "")
      .map(({ command, flag }) => `pixelslash ${command} ${flag}`);
    expect(bad).toEqual([]);
  });

  test("the markdown has the table, a section per command and a flag table", () => {
    const markdown = commandIndexMarkdown(INDEX);
    for (const entry of INDEX) {
      expect(markdown).toContain(`| \`pixelslash ${entry.command}\` |`);
      expect(markdown).toContain(`### pixelslash ${entry.command}`);
    }
    expect(markdown).toContain("| Flag | Takes | What it does |");
  });
});

const MARKDOWN = commandIndexMarkdown(INDEX);
const flagOf = (command: string, flag: string): string =>
  INDEX.find((entry) => entry.command === command)?.flags.find((f) => f.flag === flag)?.what ?? "";
/** One command's section of the markdown, from its heading to the next. */
const sectionOf = (command: string): string =>
  MARKDOWN.split("\n### ").find((part) => part.startsWith(`pixelslash ${command}\n`)) ?? "";

describe("the reference text", () => {
  test("compare says the subcommand can be left out for a pair, and shows that form", () => {
    const compare = sectionOf("compare");
    expect(compare).toContain("`pixelslash --live URL --local URL`");
    expect(compare).toContain("leave the subcommand out");
    expect(compare).not.toMatch(/^pixelslash compare \(/m);
    expect(compare).toMatch(/^pixelslash \(--live URL/m);
  });

  test("init --routes is a comma list and compare --routes is a file", () => {
    expect(flagOf("init", "--routes")).toBe("The paths to shoot, separated by commas.");
    expect(flagOf("compare", "--routes")).toMatch(/file of paths/i);
  });

  test("install-browser is under Install, not under signing in", () => {
    expect(INDEX.find((entry) => entry.command === "install-browser")?.page).toBe("install");
    const signingIn = JSON.stringify(CLI_SPLIT.pages.get("signing-in"));
    expect(signingIn).not.toContain("install-browser [");
  });

  test("--wait names what it waits for and the exit codes it maps to", () => {
    const wait = flagOf("status", "--wait");
    expect(wait).toMatch(/waits? until the server decides the build/i);
    for (const code of ["0", "3", "4", "5"]) expect(wait).toMatch(new RegExp(`\\b${code}\\b`));
  });

  test("--threshold and --flake-retries name their defaults", () => {
    expect(flagOf("compare", "--threshold")).toContain("0.01");
    expect(flagOf("upload", "--flake-retries")).toContain("default 2");
  });

  test("the reference links the exit codes page", () => {
    expect(MARKDOWN).toContain("](/docs/exit-codes)");
  });
});

describe("flagsOf", () => {
  test("takes the placeholder after a flag and none for a switch", () => {
    expect(flagsOf("pixelslash upload [--dir DIR] [--wait] [--timeout SECONDS]")).toEqual([
      { flag: "--dir", takes: "DIR" },
      { flag: "--wait", takes: "" },
      { flag: "--timeout", takes: "SECONDS" },
    ]);
  });
});
