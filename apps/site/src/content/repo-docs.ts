import security from "../../../../SECURITY.md?raw";
import selfHost from "../../../web/SELF-HOST.md?raw";
import { parseDoc } from "./markdown.tsx";

/*
 * The two repo documents that are a site page of their own, read at build time. Apart from the
 * docs pages, so neither page carries the docs' text and no docs page carries theirs.
 */
export const SELF_HOST_DOC = parseDoc(selfHost, "apps/web/SELF-HOST.md");
export const SECURITY_DOC = parseDoc(security, "SECURITY.md");
