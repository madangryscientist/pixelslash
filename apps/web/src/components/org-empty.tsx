import { Body, BodyStrong, Button, Card, CopyLine, EmptyState, Step, Steps } from "@hackcove/ui";

/** An org with no projects: what a project is, and the two steps to a first build. */
export function EmptyOrg({
  serverUrl,
  onNewProject,
  hydrated,
}: {
  serverUrl: string;
  onNewProject: () => void;
  hydrated: boolean;
}) {
  const command = `PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}`;
  return (
    <Card as="div" dashed="filled" data-testid="empty-org">
      <EmptyState
        title="No projects yet"
        actions={
          <Button disabled={!hydrated} onClick={onNewProject}>
            + New project
          </Button>
        }
      >
        <Body as="p" tone="muted">
          A project holds one app's builds. Make one, issue a token in its settings, then upload
          from CI or your machine.
        </Body>
        <Steps>
          <Step
            title={
              <>
                Create a project and open <BodyStrong>Settings → Issue token</BodyStrong>.
              </>
            }
          />
          <Step title="Upload a build:">
            <CopyLine text={command} disabled={!hydrated} data-testid="upload-command" />
          </Step>
        </Steps>
      </EmptyState>
    </Card>
  );
}
