import cli from "../../../../docs/cli.md?raw";
import { splitCli } from "./cli-pages.ts";
import { stripTicketIds } from "./doc-text.ts";

/** docs/cli.md cut into its pages, for the tests. The site reads the build's cut (`cli-meta.ts`). */
export const CLI_SPLIT = splitCli(stripTicketIds(cli));
