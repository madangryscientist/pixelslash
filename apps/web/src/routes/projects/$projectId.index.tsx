import { Link, createFileRoute } from "@tanstack/react-router";
import {
  Breadcrumbs,
  Button,
  Card,
  Code,
  CopyLine,
  EmptyState,
  ListLayout,
  Step,
  Steps,
  TextLink,
  Text,
} from "@hackcove/ui-react";
import { orgCrumb, projectCrumb } from "#/components/crumbs";
import { SubprojectList } from "#/components/subprojects";
import { ProjectFlags } from "#/components/detection-flag";
import { BuildsList } from "#/components/builds-list";
import { StaleList } from "#/components/stale";
import { Page, useHydrated } from "#/components/ui";
import { getProjectPage } from "#/server/fns";
import { getSubprojects } from "#/server/subprojects";

export const Route = createFileRoute("/projects/$projectId/")({
  loader: async ({ params }) => {
    const data = { projectId: params.projectId };
    const [page, subprojects] = await Promise.all([
      getProjectPage({ data }),
      getSubprojects({ data }),
    ]);
    return { ...page, subprojects };
  },
  component: ProjectPage,
});

function ProjectPage() {
  const { project, org, builds, flags, stale, now, serverUrl, subprojects } = Route.useLoaderData();
  const parentCrumbs = project.parent ? [projectCrumb(project.parent)] : [];
  return (
    <Page>
      <ListLayout
        breadcrumbs={<Breadcrumbs crumbs={[orgCrumb(org), ...parentCrumbs, project.name]} />}
        title={project.name}
        subtitle={
          builds.length === 0
            ? "No builds yet."
            : `Builds newest first. ${builds.length} in this project.`
        }
        actions={
          <>
            <Button
              variant="outline"
              render={(props) => (
                <Link
                  to="/projects/$projectId/flakes"
                  params={{ projectId: project.id }}
                  {...props}
                />
              )}
            >
              Flakes
            </Button>
            <Button
              variant="outline"
              render={(props) => (
                <Link
                  to="/projects/$projectId/settings"
                  params={{ projectId: project.id }}
                  {...props}
                />
              )}
            >
              Settings
            </Button>
          </>
        }
      >
        <SubprojectList subprojects={subprojects} defaultBranch={project.defaultBranch} />
        {builds.length === 0 ? (
          <EmptyProject project={project} serverUrl={serverUrl} />
        ) : (
          <BuildsList
            projectId={project.id}
            defaultBranch={project.defaultBranch}
            builds={builds}
            now={now}
          />
        )}
        <StaleList items={stale} />
        <ProjectFlags projectId={project.id} flags={flags} />
      </ListLayout>
    </Page>
  );
}

/**
 * A project with no builds: where the token comes from and the exact command that uploads. A
 * subproject's token is its parent's, so the link goes there and the command names the subproject.
 */
function EmptyProject({
  project,
  serverUrl,
}: {
  project: { id: string; name: string; parent: { id: string; name: string } | null };
  serverUrl: string;
}) {
  const hydrated = useHydrated();
  const flag = project.parent ? ` --subproject ${project.name}` : "";
  const command = `PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}${flag}`;
  const tokenOwner = project.parent ?? project;
  return (
    <Card as="div" dashed="filled" data-testid="empty-project">
      <EmptyState title="No builds yet">
        <Text as="p" tone="muted">
          A build is one upload of snapshots from CI or your machine. Builds on <Code>main</Code>{" "}
          are accepted as they land; a branch's builds are compared against them.
        </Text>
        <Steps>
          <Step
            title={
              <>
                Issue a CI token in{" "}
                <TextLink
                  render={(props) => (
                    <Link
                      to="/projects/$projectId/settings"
                      params={{ projectId: tokenOwner.id }}
                      {...props}
                    />
                  )}
                >
                  {project.parent ? `${project.parent.name}'s settings` : "Settings"}
                </TextLink>
                .
              </>
            }
          />
          <Step title="Upload a snapshot dir with it:">
            <CopyLine text={command} disabled={!hydrated} data-testid="upload-command" />
          </Step>
        </Steps>
      </EmptyState>
    </Card>
  );
}
