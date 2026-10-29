import {
  BulletList,
  Callout,
  Code,
  CodeBlock,
  type CodeLanguage,
  Divider,
  SectionHeading,
  SubsectionHeading,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TextLink,
} from "@hackcove/ui";
import { type MarkedToken, type Token, type Tokens, lexer } from "marked";
import { Fragment, type ReactNode } from "react";
import { resolveHref } from "./links.ts";

/*
 * A repo document (docs/cli.md, SECURITY.md, ...) rendered as React at build time. marked lexes
 * it; this file draws the tokens with the design system's parts, so no HTML string is injected and
 * every link goes through `resolveHref`.
 */

export type Heading = { depth: number; text: string; id: string };

export type Doc = {
  /** The repo path of the source, for resolving its relative links. */
  source: string;
  /** The document's own `# title`, which the page shows as its heading. */
  title: string;
  /** The blocks after the title. */
  tokens: MarkedToken[];
  headings: Heading[];
  ids: WeakMap<Token, string>;
};

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

function marked(tokens: Token[] | undefined): MarkedToken[] {
  return (tokens ?? []).filter(isMarked);
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

export function parseDoc(markdown: string, source: string): Doc {
  const all = marked(lexer(markdown));
  const first = all.find((token) => token.type !== "space");
  const title = first?.type === "heading" && first.depth === 1 ? plainText(first.tokens) : "";
  const tokens = title === "" ? all : all.filter((token) => token !== first);
  const slug = slugger();
  const headings: Heading[] = [];
  const ids = new WeakMap<Token, string>();
  for (const token of tokens) {
    if (token.type !== "heading") continue;
    const text = plainText(token.tokens);
    const id = slug(text);
    ids.set(token, id);
    headings.push({ depth: token.depth, text, id });
  }
  return { source, title, tokens, headings, ids };
}

function Inline({ tokens, doc }: { tokens: Token[] | undefined; doc: Doc }): ReactNode {
  return marked(tokens).map((token, index) => <InlineToken key={index} token={token} doc={doc} />);
}

function InlineLink({ token, doc }: { token: Tokens.Link; doc: Doc }): ReactNode {
  const href = resolveHref(token.href, doc.source);
  const children = <Inline tokens={token.tokens} doc={doc} />;
  if (href === null) return <span data-gated-link={token.href}>{children}</span>;
  return (
    <TextLink href={href} external={/^https?:/.test(href)}>
      {children}
    </TextLink>
  );
}

function InlineToken({ token, doc }: { token: MarkedToken; doc: Doc }): ReactNode {
  switch (token.type) {
    case "strong":
      return <strong>{<Inline tokens={token.tokens} doc={doc} />}</strong>;
    case "em":
      return <em>{<Inline tokens={token.tokens} doc={doc} />}</em>;
    case "del":
      return <del>{<Inline tokens={token.tokens} doc={doc} />}</del>;
    case "codespan":
      // A long path in prose would push a phone's page sideways; let it break anywhere.
      return (
        <span className="[overflow-wrap:anywhere]">
          <Code>{decode(token.text)}</Code>
        </span>
      );
    case "link":
      return <InlineLink token={token} doc={doc} />;
    case "br":
      return <br />;
    default:
      return inlineText(token, doc);
  }
}

/** Text, an escape, inline HTML (`<name>` in prose is literal text) and an image's alt text. */
function inlineText(token: MarkedToken, doc: Doc): ReactNode {
  if (token.type === "text" && token.tokens) return <Inline tokens={token.tokens} doc={doc} />;
  if (token.type === "image") return token.text;
  return "text" in token ? decode(token.text) : null;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** marked escapes `&`, `<`, `>` and quotes in text; React escapes them again, so undo marked's. */
function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

const LANGUAGES: readonly CodeLanguage[] = ["tsx", "ts", "json", "bash", "css"];

function isLanguage(name: string): name is CodeLanguage {
  return LANGUAGES.some((known) => known === name);
}

function language(lang: string | undefined): CodeLanguage {
  const name = lang === "sh" || lang === "shell" ? "bash" : (lang ?? "");
  return isLanguage(name) ? name : "text";
}

function HeadingBlock({ token, doc }: { token: Tokens.Heading; doc: Doc }): ReactNode {
  const id = doc.ids.get(token);
  const children = <Inline tokens={token.tokens} doc={doc} />;
  if (token.depth <= 2) return <SectionHeading id={id}>{children}</SectionHeading>;
  return (
    <SubsectionHeading
      as={token.depth === 3 ? "h3" : "h4"}
      size={token.depth === 3 ? "md" : "sm"}
      id={id}
    >
      {children}
    </SubsectionHeading>
  );
}

function ListBlock({ token, doc }: { token: Tokens.List; doc: Doc }): ReactNode {
  const items = token.items.map((item, index) => (
    <li key={index} className="text-sm/6">
      <Blocks tokens={marked(item.tokens)} doc={doc} />
    </li>
  ));
  if (token.ordered) return <ol className="list-decimal space-y-1 pl-5">{items}</ol>;
  return <BulletList>{items}</BulletList>;
}

function TableBlock({ token, doc }: { token: Tokens.Table; doc: Doc }): ReactNode {
  return (
    <Table>
      <TableHead>
        <TableRow>
          {token.header.map((cell, index) => (
            <TableHeaderCell key={index}>
              <Inline tokens={cell.tokens} doc={doc} />
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {token.rows.map((row, rowIndex) => (
          <TableRow key={rowIndex}>
            {row.map((cell, index) => (
              <TableCell key={index}>
                <Inline tokens={cell.tokens} doc={doc} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type BlockRenderer = (token: MarkedToken, doc: Doc) => ReactNode;

/** One renderer per block type, a map rather than a switch so each stays small. */
const BLOCKS: Partial<Record<MarkedToken["type"], BlockRenderer>> = {
  heading: (token, doc) => token.type === "heading" && <HeadingBlock token={token} doc={doc} />,
  paragraph: (token, doc) =>
    token.type === "paragraph" && (
      <p className="text-sm/6">
        <Inline tokens={token.tokens} doc={doc} />
      </p>
    ),
  code: (token) =>
    token.type === "code" && (
      <CodeBlock language={language(token.lang)} {...(token.lang ? { label: token.lang } : {})}>
        {token.text}
      </CodeBlock>
    ),
  list: (token, doc) => token.type === "list" && <ListBlock token={token} doc={doc} />,
  table: (token, doc) => token.type === "table" && <TableBlock token={token} doc={doc} />,
  blockquote: (token, doc) =>
    token.type === "blockquote" && (
      <Callout tone="neutral">
        <Blocks tokens={marked(token.tokens)} doc={doc} />
      </Callout>
    ),
  hr: () => <Divider />,
  text: (token, doc) => <InlineToken token={token} doc={doc} />,
};

function Blocks({ tokens, doc }: { tokens: MarkedToken[]; doc: Doc }): ReactNode {
  return tokens.map((token, index) => {
    const render = BLOCKS[token.type];
    return render ? <Fragment key={index}>{render(token, doc)}</Fragment> : null;
  });
}

/** A whole document's body, its blocks a steady gap apart. */
export function DocBody({ doc }: { doc: Doc }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-doc={doc.source}>
      <Blocks tokens={doc.tokens} doc={doc} />
    </div>
  );
}
