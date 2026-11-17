import {
  Button,
  ButtonGroup,
  Card,
  Checkbox,
  Code,
  CopyLine,
  SectionHeading,
  Stack,
  Text,
} from "@hackcove/ui-react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { InlineForm, useHydrated } from "#/components/ui";
import { saveDefaultBranch } from "#/server/fns";
import { saveGithubComment, saveGithubRepo } from "#/server/github-repo";

/** The project settings' default-branch card. */
export function DefaultBranch({ projectId, branch }: { projectId: string; branch: string }) {
  const router = useRouter();
  return (
    <Card>
      <Stack>
        <Stack gap="xs">
          <SectionHeading>Default branch</SectionHeading>
          <Text as="p">
            Builds on this branch are accepted without review and become the baseline for branch
            builds. Builds on other branches wait for review.
          </Text>
        </Stack>
        <InlineForm
          label="Default branch, e.g. main"
          button="Save"
          busyLabel="Saving…"
          emptyReason="Name the branch: the one you merge into."
          initialValue={branch}
          onSubmit={async (next) => {
            await saveDefaultBranch({ data: { projectId, branch: next } });
            await router.invalidate();
          }}
        />
      </Stack>
    </Card>
  );
}

/** The opt-out for the pull request comment (PS-82); the commit status is sent either way. */
function CommentToggle({ projectId, comment }: { projectId: string; comment: boolean }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const set = async (next: boolean) => {
    await saveGithubComment({ data: { projectId, comment: next } });
    await router.invalidate();
  };
  return (
    <Checkbox
      align="start"
      checked={comment}
      disabled={!hydrated}
      onChange={(e) => void set(e.target.checked)}
      data-testid="github-comment"
      label={<Text strong>Comment on pull requests</Text>}
      description="Off, no comment is posted or edited; the commit status is sent either way."
    />
  );
}

/** The project settings' GitHub repo card (PS-23): where each build's commit status goes. */
export function GithubRepo({
  projectId,
  repo,
  comment,
  configured,
}: {
  projectId: string;
  repo: string | null;
  comment: boolean;
  configured: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const save = async (next: string | null) => {
    await saveGithubRepo({ data: { projectId, repo: next } });
    await router.invalidate();
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await save(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="github-repo">
      <Stack>
        <Stack gap="xs">
          <SectionHeading>GitHub repo</SectionHeading>
          <Text as="p">
            Each build posts a PixelSlash commit status on its commit: pending while changes wait
            for review, passing once they are accepted, failing when one is rejected. Its Details
            link opens the build. A branch protection rule that requires PixelSlash keeps working by
            name; pick it again if the rule was tied to the old check run. The status carries a
            title and a link, never a screenshot. A pull request's builds also keep one comment,
            edited in place, with the model's summary, the counts and the most changed shots as
            links.
          </Text>
          {!configured && (
            <Text as="p">
              This server has no GitHub App or token set up, so no commit statuses or comments are
              sent yet.
            </Text>
          )}
        </Stack>
        <InlineForm
          label="Repo, e.g. acme/web"
          button={repo ? "Save" : "Connect"}
          busyLabel="Saving…"
          emptyReason="Name the repo as owner/name."
          initialValue={repo ?? ""}
          onSubmit={save}
        />
        <CommentToggle projectId={projectId} comment={comment} />
        {repo && (
          <ButtonGroup>
            <Button
              variant="ghost"
              tone="danger"
              disabled={!hydrated}
              busy={busy}
              busyLabel="Disconnecting…"
              onClick={() => void disconnect()}
            >
              Disconnect {repo}
            </Button>
          </ButtonGroup>
        )}
      </Stack>
    </Card>
  );
}

/** The project settings' upload-command card; a subproject's names it, with its parent's token. */
export function UploadCommand({
  serverUrl,
  subproject,
}: {
  serverUrl: string;
  subproject?: string | undefined;
}) {
  const hydrated = useHydrated();
  return (
    <Card>
      <Stack>
        <Stack gap="xs">
          <SectionHeading>Upload a build</SectionHeading>
          <Text as="p">
            From CI or your machine, with the token in <Code>PIXELSLASH_TOKEN</Code>:
          </Text>
        </Stack>
        <CopyLine
          text={`PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}${subproject ? ` --subproject ${subproject}` : ""}`}
          disabled={!hydrated}
          data-testid="upload-command"
        />
      </Stack>
    </Card>
  );
}
