import type { MarkedToken, Tokens } from "marked";
import { marked } from "./doc-text.ts";
import { FLAG_NOTES } from "./cli-index-notes.ts";
import { findPage } from "./docs-map.ts";

/*
 * The command index: every `pixelslash` command, the page that owns it and its flags, generated
 * from the synopsis blocks of docs/cli.md at build time, so it cannot list a command the file does
 * not document. A test compares it with the CLI's own command table (packages/cli/src/run.ts).
 */

/** One line per command, for the index table. A test requires one for every command the CLI has. */
export const COMMAND_SUMMARY: Readonly<Record<string, string>> = {
  init: "Write a pixelslash.config.ts from a few answers.",
  capture: "Shoot every route and variant of a config into a snapshot dir.",
  compare: "Compare two versions, or two snapshot dirs, and write a report.",
  import: "Turn a dir of PNGs from any screenshot tool into a snapshot dir.",
  upload: "Send a snapshot dir to a review server as a build.",
  check: "Run the diff a server would run, before you push.",
  dev: "Re-capture a feature as you build it.",
  "install-browser": "Download the browsers capture launches.",
  login: "Sign in to a server and keep the token.",
  logout: "Forget the saved token.",
  whoami: "Show who the token signs in as.",
  builds: "List the builds of a project.",
  build: "Show one build: its shots, their groups and their review state.",
  status: "Say whether a build is green, and wait for it if asked.",
  parity: "Compare the layout of twin shots on two platforms.",
  mcp: "Start the MCP server so a coding agent can use PixelSlash.",
  flakes: "List the shots a project has found flaky.",
  flake: "Reproduce a flaky shot locally and suggest a fix.",
  project: "Create or list the projects of an org.",
};

/**
 * One sentence shown after a command's usage, for what the usage alone does not say. `compare` is
 * two snapshot dirs; a pair of URLs or PNGs is the bare form, with no subcommand.
 */
const AFTER_USAGE: Readonly<Record<string, string>> = {
  compare:
    "For a pair of URLs or PNGs, leave the subcommand out: `pixelslash --live URL --local URL` is that run, and `pixelslash compare` itself takes two snapshot dirs.",
};

/** The page a command belongs on when its synopsis is shown on several. */
const HOME: Readonly<Record<string, string>> = {
  capture: "capture",
  compare: "compare",
  upload: "upload",
  mcp: "mcp",
  parity: "parity",
  flake: "upload-flaky",
  flakes: "upload-flaky",
  check: "check",
  dev: "dev",
  init: "init",
  import: "pngs",
  "install-browser": "install",
};

export type CommandFlag = { flag: string; takes: string; what: string };
export type CommandEntry = {
  command: string;
  summary: string;
  page: string;
  usage: string[];
  flags: CommandFlag[];
};

function codeBlocks(tokens: readonly MarkedToken[]): Tokens.Code[] {
  return tokens.flatMap((token): Tokens.Code[] => {
    if (token.type === "code") return [token];
    if (token.type === "list")
      return token.items.flatMap((item) => codeBlocks(marked(item.tokens)));
    return [];
  });
}

const DOCKER = /^docker run .* pixelslash-capture:dev /;
const BARE = /^pixelslash ([a-z][a-z-]*)(?= |$)/;

/** `docker run … capture […]` and `bun run pixelslash -- (--live …)` read as the command they run. */
function synopsisLines(code: string): string[] {
  return code
    .split("\n")
    .flatMap((raw) => raw.trim().split(" · "))
    .map((line) =>
      line
        .replace(DOCKER, "pixelslash ")
        .replace(/^bun run pixelslash -- (?=\()/, "pixelslash compare "),
    )
    .filter((line) => BARE.test(line) && /\[|\(|\b[A-Z]{2,}\b/.test(line));
}

/** The pair form is typed without a subcommand; the index files it under `compare`. */
const shownUsage = (line: string): string => line.replace(/^pixelslash compare \(/, "pixelslash (");

function takesOf(token: string | undefined): string {
  if (token === undefined) return "";
  const arg = token.replace(/[\])….]+$/, "");
  return arg === "" || /^[-[(|·]/.test(arg) ? "" : arg;
}

/** The flags in a synopsis line, each with the placeholder that follows it. */
export function flagsOf(line: string): { flag: string; takes: string }[] {
  const words = line.split(/\s+/);
  const out: { flag: string; takes: string }[] = [];
  words.forEach((word, index) => {
    const match = /^[[(]*(--[a-z][a-z0-9-]*)(.*)$/.exec(word);
    if (!match?.[1]) return;
    const closed = /[\])]/.test(match[2] ?? "");
    out.push({ flag: match[1], takes: closed ? "" : takesOf(words[index + 1]) });
  });
  return out;
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = /[.!?](?=\s|$)/.exec(flat);
  const sentence = end ? flat.slice(0, end.index + 1) : flat;
  return sentence.length > 160 ? `${sentence.slice(0, 157).trimEnd()}…` : sentence;
}

/** What cli.md says about a flag where it is described: a bullet or a table row that opens with it. */
function describers(tokens: readonly MarkedToken[]): Map<string, string> {
  const found = new Map<string, string>();
  const add = (text: string): void => {
    const lead =
      /^(`--[a-z][a-z0-9-]*[^`]*`(?:,? (?:and |or )?`--[a-z][a-z0-9-]*[^`]*`)*)[.:,]? ?(.*)$/s.exec(
        text,
      );
    if (!lead?.[1] || !lead[2]) return;
    const what = firstSentence(lead[2].replace(/^\*\*|\*\*$/g, ""));
    for (const flag of lead[1].match(/--[a-z][a-z0-9-]*/g) ?? [])
      if (!found.has(flag)) found.set(flag, what);
  };
  const addRow = (row: readonly Tokens.TableCell[]): void => {
    // The last cell of a flag table is its meaning; the ones between are its range and default.
    const first = row[0]?.text;
    const last = row.length > 1 ? row.at(-1)?.text : undefined;
    if (first && last) add(`${first} ${last}`);
  };
  const walk = (list: readonly MarkedToken[]): void => {
    for (const token of list) {
      if (token.type === "paragraph") add(token.text);
      if (token.type === "table") token.rows.forEach(addRow);
      if (token.type !== "list") continue;
      for (const item of token.items) {
        add(item.text);
        walk(marked(item.tokens));
      }
    }
  };
  walk(tokens);
  return found;
}

type Seen = { page: string; line: string };

type CliPages = ReadonlyMap<string, readonly MarkedToken[]>;

function commandOf(line: string): string {
  return BARE.exec(line)?.[1] ?? "";
}

/** Every synopsis line in cli.md, by command, with the page it is shown on. */
function collect(pages: CliPages): Map<string, Seen[]> {
  const seen = new Map<string, Seen[]>();
  for (const [slug, tokens] of pages) {
    for (const block of codeBlocks(tokens)) {
      for (const line of synopsisLines(block.text)) {
        const command = commandOf(line);
        seen.set(command, [...(seen.get(command) ?? []), { page: slug, line }]);
      }
    }
  }
  return seen;
}

function ownerOf(command: string, seen: readonly Seen[]): string {
  const home = HOME[command];
  if (home !== undefined && seen.some((entry) => entry.page === home)) return home;
  const first = seen[0];
  if (first === undefined) throw new Error(`cli index: no synopsis for ${command}`);
  return first.page;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** The index, from cli.md cut into its pages (`splitCli`). */
export function buildCommandIndex(pages: CliPages): CommandEntry[] {
  const seen = collect(pages);
  const everywhere = describers([...pages.values()].flat());
  const pageDescribed = new Map(
    [...pages].map(([slug, tokens]) => [slug, describers(tokens)] as const),
  );
  // A flag several commands take can mean something different to each, so its prose is read only
  // from the pages that show this command's own synopsis; a flag one command owns is read anywhere.
  const owners = new Map<string, number>();
  for (const [command, entries] of seen) {
    for (const flag of new Set(entries.flatMap((entry) => flagsOf(entry.line).map((f) => f.flag))))
      owners.set(flag, (owners.get(flag) ?? 0) + (command === "" ? 0 : 1));
  }
  const describe = (command: string, flag: string, entries: readonly Seen[]): string => {
    const local = entries.map((entry) => pageDescribed.get(entry.page)?.get(flag)).find(Boolean);
    const prose = owners.get(flag) === 1 ? (local ?? everywhere.get(flag)) : local;
    return (
      (prose !== undefined && /^[A-Z]/.test(prose) ? prose : undefined) ??
      FLAG_NOTES[`${command} ${flag}`] ??
      FLAG_NOTES[flag] ??
      ""
    );
  };
  return [...seen.entries()].map(([command, entries]) => {
    const page = ownerOf(command, entries);
    const byFlag = new Map<string, string>();
    for (const entry of entries) {
      for (const { flag, takes } of flagsOf(entry.line)) {
        if (!byFlag.has(flag) || (byFlag.get(flag) === "" && takes !== "")) byFlag.set(flag, takes);
      }
    }
    return {
      command,
      summary: COMMAND_SUMMARY[command] ?? "",
      page,
      usage: unique(entries.map((entry) => shownUsage(entry.line))),
      flags: [...byFlag.entries()].map(([flag, takes]) => ({
        flag,
        takes,
        what: describe(command, flag, entries),
      })),
    };
  });
}

const title = (slug: string): string => findPage(slug)?.title ?? slug;

const cell = (text: string): string => text.replace(/\|/g, "\\|");

/** The index page as markdown: one table of commands, then a usage block and a flag table each. */
export function commandIndexMarkdown(entries: readonly CommandEntry[]): string {
  const lines: string[] = [
    "# Every command",
    "",
    "Every `pixelslash` command in one line, the page that explains it and its flags. It is generated from the synopsis blocks of `docs/cli.md`, so it lists what the CLI reference documents.",
    "",
    "A command given a bad flag prints its own usage line and exits 2; `pixelslash --version` prints the version and exits 0. Every other exit code, and what a runner does with it, is on [Exit codes](/docs/exit-codes).",
    "",
    "```sh\npixelslash --version\n```",
    "",
    "## The commands",
    "",
    "| Command | What it does | Page |",
    "| --- | --- | --- |",
    ...entries.map(
      (entry) =>
        `| \`pixelslash ${entry.command}\` | ${cell(entry.summary)} | [${title(entry.page)}](/docs/${entry.page}) |`,
    ),
    "",
    "## The flags of each command",
    "",
  ];
  for (const entry of entries) {
    lines.push(
      `### pixelslash ${entry.command}`,
      "",
      `${entry.summary} On [${title(entry.page)}](/docs/${entry.page}).`,
      "",
      "```sh",
      ...entry.usage,
      "```",
      "",
      ...(AFTER_USAGE[entry.command] === undefined ? [] : [AFTER_USAGE[entry.command] ?? "", ""]),
    );
    if (entry.flags.length > 0) {
      lines.push(
        "| Flag | Takes | What it does |",
        "| --- | --- | --- |",
        ...entry.flags.map(
          (flag) =>
            `| \`${flag.flag}\` | ${flag.takes === "" ? "" : `\`${cell(flag.takes)}\``} | ${cell(flag.what)} |`,
        ),
        "",
      );
    }
  }
  return lines.join("\n");
}
