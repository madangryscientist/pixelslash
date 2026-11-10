import cli from "../../../../docs/cli.md?raw";
import { splitCli } from "./cli-pages.ts";
import { stripTicketIds } from "./doc-text.ts";

/** docs/cli.md cut into its pages. Only the cli pages load this; the rest read `virtual:cli-meta`. */
export const CLI_SPLIT = splitCli(stripTicketIds(cli));
