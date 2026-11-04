import { Breadcrumbs, ListLayout, Text } from "@hackcove/ui-react";
import { createFileRoute } from "@tanstack/react-router";
import { buildCrumb, orgCrumb, projectCrumb } from "#/components/crumbs";
import { ParityBody } from "#/components/parity-view";
import { Page } from "#/components/ui";
import { getParityPage } from "#/server/parity-page";

type Search = { name: string; theme: string };

export const Route = createFileRoute("/projects/$projectId/builds/$buildId_/parity")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    name: typeof search.name === "string" ? search.name : "",
    theme: typeof search.theme === "string" ? search.theme : "",
  }),
  loaderDeps: ({ search }) => ({ name: search.name, theme: search.theme }),
  loader: ({ params, deps }) =>
    getParityPage({
      data: { projectId: params.projectId, buildId: params.buildId, ...deps },
    }),
  component: ParityPage,
});

function ParityPage() {
  const { org, project, build, parity } = Route.useLoaderData();
  return (
    <Page>
      <ListLayout
        breadcrumbs={
          <Breadcrumbs
            crumbs={[
              orgCrumb(org),
              projectCrumb(project),
              buildCrumb(project.id, build),
              `${parity.name} ${parity.theme}`,
            ]}
          />
        }
        title={`${parity.name} · ${parity.theme}`}
      >
        <Text as="p" tone="muted">
          The same key on web, Android and iOS, at one physical size.
        </Text>
        <ParityBody view={parity} />
      </ListLayout>
    </Page>
  );
}
