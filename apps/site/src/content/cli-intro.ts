import { CLI_INTRO } from "virtual:cli-meta";
import { parseDoc } from "./markdown.tsx";

/** What docs/cli.md says before its first section: the docs index leads with it. */
export const CLI_INTRO_DOC = parseDoc(CLI_INTRO, "docs/cli.md");
