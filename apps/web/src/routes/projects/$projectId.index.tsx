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
import { orgCrumb } from "#/components/crumbs";
import { ProjectFlags } from "#/components/detection-flag";
import { BuildsList } from "#/components/builds-list";
import { StaleList } from "#/components/stale";
import { Page, useHydrated } from "#/components/ui";
import { getProjectPage } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/")({
  loader: ({ params }) => getProjectPage({ data: { projectId: params.projectId } }),
  component: ProjectPage,
});

function ProjectPage() {
  const { project, org, builds, flags, stale, now, serverUrl } = Route.useLoaderData();
  return (
    <Page>
      <ListLayout
        breadcrumbs={<Breadcrumbs crumbs={[orgCrumb(org), project.name]} />}
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
        {builds.length === 0 ? (
          <EmptyProject projectId={project.id} serverUrl={serverUrl} />
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

/** A project with no builds: where the token comes from and the exact command that uploads. */
function EmptyProject({ projectId, serverUrl }: { projectId: string; serverUrl: string }) {
  const hydrated = useHydrated();
  const command = `PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}`;
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
                    <Link to="/projects/$projectId/settings" params={{ projectId }} {...props} />
                  )}
                >
                  Settings
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
