import readme from "../../../../README.md?raw";
import security from "../../../../SECURITY.md?raw";
import cli from "../../../../docs/cli.md?raw";
import selfHost from "../../../web/SELF-HOST.md?raw";
import { parseDoc } from "./markdown.tsx";

/*
 * The repo's own documents, read at build time. A page renders what the file says today; it never
 * keeps a copy of its own, so the site cannot drift from the docs.
 */
export const CLI_DOC = parseDoc(cli, "docs/cli.md");
export const SELF_HOST_DOC = parseDoc(selfHost, "apps/web/SELF-HOST.md");
export const SECURITY_DOC = parseDoc(security, "SECURITY.md");

/** The README's trademark sentence, verbatim (line breaks folded), for the footer. */
export function trademarkLine(markdown: string): string {
  const match = /PixelSlash is a name of[^.]*;[^.]*\./.exec(markdown.replace(/\s+/g, " "));
  if (!match) throw new Error("README.md no longer carries the trademark line the footer shows");
  return match[0];
}

export const TRADEMARK = trademarkLine(readme);
