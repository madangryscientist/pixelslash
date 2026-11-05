import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { COMMAND_SUMMARY, buildCommandIndex, commandIndexMarkdown, flagsOf } from "./cli-index.ts";
import { CLI_SPLIT } from "./cli-pages.ts";
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

const INDEX = buildCommandIndex();

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

describe("flagsOf", () => {
  test("takes the placeholder after a flag and none for a switch", () => {
    expect(flagsOf("pixelslash upload [--dir DIR] [--wait] [--timeout SECONDS]")).toEqual([
      { flag: "--dir", takes: "DIR" },
      { flag: "--wait", takes: "" },
      { flag: "--timeout", takes: "SECONDS" },
    ]);
  });
});
