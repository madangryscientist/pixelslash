import type { MarkedToken, Tokens } from "marked";
import { marked } from "./doc-text.ts";
import { CLI_SPLIT } from "./cli-pages.ts";
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

/**
 * One line for a flag cli.md does not describe where a bullet or a table row can be lifted from. The
 * prose wins when it has the flag; a test requires every flag of the index to have a line either way.
 */
const FLAG_NOTES: Readonly<Record<string, string>> = {
  "--url": "Shoot this page instead of a config's routes.",
  "--storybook": "The Storybook this project captures, without probing for it.",
  "--viewports": "The viewports to shoot, as WxH separated by commas.",
  "--themes": "The themes to shoot: light, dark, or both.",
  "--server":
    "The review server to talk to; else PIXELSLASH_SERVER, else the config's upload.server.",
  "--project":
    "The project, by id or name; else the config's upload.project, else the only one the token sees.",
  "--yes": "Take the default for every question not answered by a flag.",
  "--force": "Overwrite a config that already exists.",
  "--only": "Capture just these routes or stories; repeat it for more.",
  "--upload": "Send the snapshots to the server as a build once they are shot.",
  "--token-path": "A file holding the token; else PIXELSLASH_TOKEN, else the one `login` stored.",
  "--base":
    "The branch the build is compared against; else the config's upload.baseBranch, else main.",
  "--branch": "The branch name the build is recorded under.",
  "--pr": "The pull request number the build is recorded under.",
  "--flake-retries":
    "How many more times a shot that differs from its baseline is captured; 0 turns it off.",
  "--brief": "A file holding your own words on what the build means to change.",
  "--brief-text": "Your own words on what the build means to change, given inline.",
  "--wait": "Wait for the build to be decided, as `status --wait` does, and exit as it does.",
  "--timeout": "How long to wait before giving up, such as 30m.",
  "--interval": "How often to read the build while waiting, such as 15s.",
  "--viewport": "The viewport of these PNGs, as WxH.",
  "--theme": "The theme of these shots: light or dark.",
  "--renderer": "A label for what drew the PNGs, kept with the snapshots.",
  "--device": "The device the native screenshots came from, such as a phone model.",
  "--scale": "The device's pixel ratio, a number above 0.",
  "--build": "The build to read, by id.",
  "--manifest":
    "The parity manifest; else pixelslash.parity.json in the working directory when it exists.",
  "--release": "The release check for one native platform: android or ios.",
  "--local": "Branch: the URL of your change, which must already be up.",
  "--local-png": "Branch: a screenshot you already have.",
  "--live-png-dir": "Main: a directory of screenshots, one per route.",
  "--local-png-dir": "Branch: a directory of screenshots, one per route.",
  "--file": "A Figma file key to take the design system from.",
  "--width": "The width to shoot the pages at, in pixels (default 1280).",
  "--label": "A name for the run, kept in the manifest and shown in the report.",
  "--limit": "How many builds to list, 1 to 100.",
  "--commit": "Read the newest build at this commit.",
  "--dir": "The snapshot dir whose build.json names the build.",
  "--org": "The organisation to create the project in.",
  "--runs": "How many times to capture the shot, 2 to 50 (default 5).",
  "--note": "Why the flake is resolved, at most 200 characters.",
  "--figma-token-path": "A file holding the Figma token; else FIGMA_TOKEN.",
  "--watch":
    "Watch only these paths instead of the git working tree; repeat it or separate with commas.",
  "--against": "What to compare with: main for the server's baselines, previous for the last run.",
  "--refresh-refs": "Fetch the Figma references again.",
  "--once": "Run once and exit, without the live page or the watcher.",
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
    const [first, ...rest] = row.map((cell) => cell.text);
    if (first) add(`${first} ${rest.join(" ")}`);
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

function commandOf(line: string): string {
  return BARE.exec(line)?.[1] ?? "";
}

/** Every synopsis line in cli.md, by command, with the page it is shown on. */
function collect(): Map<string, Seen[]> {
  const seen = new Map<string, Seen[]>();
  for (const [slug, tokens] of CLI_SPLIT.pages) {
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

export function buildCommandIndex(): CommandEntry[] {
  const seen = collect();
  const described = describers([...CLI_SPLIT.pages.values()].flat());
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
      usage: unique(entries.map((entry) => entry.line.replace(/^pixelslash /, "pixelslash "))),
      flags: [...byFlag.entries()].map(([flag, takes]) => ({
        flag,
        takes,
        what: described.get(flag) ?? FLAG_NOTES[flag] ?? "",
      })),
    };
  });
}

const title = (slug: string): string => findPage(slug)?.title ?? slug;

const cell = (text: string): string => text.replace(/\|/g, "\\|");

/** The index page as markdown: one table of commands, then a usage block and a flag table each. */
export function commandIndexMarkdown(
  entries: readonly CommandEntry[] = buildCommandIndex(),
): string {
  const lines: string[] = [
    "# Every command",
    "",
    "Every `pixelslash` command in one line, the page that explains it and its flags. It is generated from the synopsis blocks of `docs/cli.md`, so it lists what the CLI reference documents.",
    "",
    "A command given a bad flag prints its own usage line and exits 2; `pixelslash --version` prints the version and exits 0.",
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
