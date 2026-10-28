import {
  Button,
  ButtonGroup,
  Card,
  Code,
  CopyLine,
  SectionHeading,
  Stack,
  Text,
} from "@hackcove/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { InlineForm, useHydrated } from "#/components/ui";
import { saveDefaultBranch } from "#/server/fns";
import { saveGithubRepo } from "#/server/github-repo";

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

/** The project settings' GitHub repo card (PS-23): where each build's check run goes. */
export function GithubRepo({
  projectId,
  repo,
  appConfigured,
}: {
  projectId: string;
  repo: string | null;
  appConfigured: boolean;
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
            Each build posts a PixelSlash check run on its commit: failing while changes wait for
            review or one is rejected, passing once they are accepted. The check carries counts and
            a link, never a screenshot.
          </Text>
          {!appConfigured && (
            <Text as="p">This server has no GitHub App set up, so no check runs are sent yet.</Text>
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

/** The project settings' upload-command card. */
export function UploadCommand({ serverUrl }: { serverUrl: string }) {
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
          text={`PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}`}
          disabled={!hydrated}
          data-testid="upload-command"
        />
      </Stack>
    </Card>
  );
}
