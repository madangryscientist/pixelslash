import { Callout, ProseLayout, SidebarLayout } from "@hackcove/ui-react";
import type { ReactNode } from "react";
import { SELF_HOST_DOC } from "../../content/docs.ts";
import { REPO_PUBLIC } from "../../content/links.ts";
import { DocBody } from "../../content/markdown.tsx";
import { DocsNav, EditLink } from "./docs";

/** apps/web/SELF-HOST.md, rendered at build time. */
export function SelfHostPage(): ReactNode {
  return (
    <SidebarLayout rail={<DocsNav current="/self-host" />} railLabel="Docs">
      <ProseLayout
        title="Self-host"
        subtitle="apps/web/SELF-HOST.md from the repository, as it is at this commit."
        gap="lg"
      >
        {REPO_PUBLIC ? null : (
          <Callout tone="info" title="The source opens at launch" data-testid="repo-closed">
            The guide below starts from a clone of the repository. The repository is not public yet,
            so until it opens these steps are a description of what self-hosting takes, not
            something you can run.
          </Callout>
        )}
        <DocBody doc={SELF_HOST_DOC} />
        <EditLink source={SELF_HOST_DOC.source} />
      </ProseLayout>
    </SidebarLayout>
  );
}
