import type { MarkedToken, Token } from "marked";

/*
 * The text of a lexed document: what a heading says, and the anchor GitHub gives it. Kept apart
 * from the renderer so the page map and the link resolver can read a document's headings without
 * pulling in React.
 */

const KNOWN = new Set<string>([
  "blockquote",
  "br",
  "code",
  "codespan",
  "def",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "html",
  "image",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "text",
]);

function isMarked(token: Token): token is MarkedToken {
  return KNOWN.has(token.type);
}

/** The tokens of a lexed document that the renderer knows how to draw. */
export function marked(tokens: Token[] | undefined): MarkedToken[] {
  return (tokens ?? []).filter(isMarked);
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** marked escapes `&`, `<`, `>` and quotes in text; React escapes them again, so undo marked's. */
export function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** The text of inline tokens, as GitHub reads it for a heading's anchor. */
export function plainText(tokens: Token[] | undefined): string {
  return marked(tokens).map(tokenText).join("");
}

function tokenText(token: MarkedToken): string {
  if ("tokens" in token && token.tokens) return plainText(token.tokens);
  return "text" in token ? decode(token.text) : "";
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to `-`, `-1`, `-2` for repeats. */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}
