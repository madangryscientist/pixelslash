import { Body, Card, Code, SectionHeading, Stack } from "@hackcove/ui";
import { useRouter } from "@tanstack/react-router";
import { CopyLine } from "#/components/copy-button";
import { InlineForm } from "#/components/ui";
import { saveDefaultBranch } from "#/server/fns";

/** The project settings' default-branch card. */
export function DefaultBranch({ projectId, branch }: { projectId: string; branch: string }) {
  const router = useRouter();
  return (
    <Card>
      <Stack>
        <Stack gap="xs">
          <SectionHeading>Default branch</SectionHeading>
          <Body as="p">
            Builds on this branch are accepted without review and become the baseline for branch
            builds. Builds on other branches wait for review.
          </Body>
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

/** The project settings' upload-command card. */
export function UploadCommand({ serverUrl, hydrated }: { serverUrl: string; hydrated: boolean }) {
  return (
    <Card>
      <Stack>
        <Stack gap="xs">
          <SectionHeading>Upload a build</SectionHeading>
          <Body as="p">
            From CI or your machine, with the token in <Code>PIXELSLASH_TOKEN</Code>:
          </Body>
        </Stack>
        <CopyLine
          text={`PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}`}
          hydrated={hydrated}
          testId="upload-command"
        />
      </Stack>
    </Card>
  );
}
