import { ProseLayout, SidebarLayout } from "@hackcove/ui";
import type { ReactNode } from "react";
import { DocBody } from "../../content/markdown.tsx";
import { CLI_DOC } from "../../content/docs.ts";

/** The rail: docs/cli.md's own headings, each linking to its anchor in the body. */
function Contents(): ReactNode {
  return (
    <nav aria-label="On this page" data-testid="docs-contents">
      <ul className="flex flex-col gap-1 text-sm/6">
        {CLI_DOC.headings
          .filter((heading) => heading.depth <= 3)
          .map((heading) => (
            <li key={heading.id} className={heading.depth === 3 ? "pl-3" : undefined}>
              <a
                href={`#${heading.id}`}
                className="text-slate-600 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-slate-100"
              >
                {heading.text}
              </a>
            </li>
          ))}
      </ul>
    </nav>
  );
}

/** docs/cli.md, rendered at build time: the page is the file, so the two cannot drift apart. */
export function DocsPage(): ReactNode {
  return (
    <SidebarLayout rail={<Contents />} railLabel="On this page">
      <ProseLayout
        title="Docs"
        subtitle="The CLI reference: docs/cli.md from the repository, as it is at this commit."
      >
        <DocBody doc={CLI_DOC} />
      </ProseLayout>
    </SidebarLayout>
  );
}
