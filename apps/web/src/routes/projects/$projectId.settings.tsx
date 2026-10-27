import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Body,
  BodyStrong,
  Breadcrumbs,
  Button,
  ButtonGroup,
  Callout,
  Card,
  CopyLine,
  Empty,
  ListLayout,
  Pill,
  SectionHeading,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@hackcove/ui";
import { orgCrumb, projectCrumb } from "#/components/crumbs";
import { IgnoreBoxSettings } from "#/components/ignore-box-settings";
import { ModelSettings } from "#/components/model-settings";
import { OverrideSettings } from "#/components/override-trail";
import { DefaultBranch, GithubRepo, UploadCommand } from "#/components/project-cards";
import { InlineForm, Page, useHydrated } from "#/components/ui";
import { formatDateTime } from "#/lib/format";
import type { DiffLocation } from "#/db/schema";
import { getProjectSettings, issueToken, revokeToken, saveDiffLocation } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/settings")({
  loader: ({ params }) => getProjectSettings({ data: { projectId: params.projectId } }),
  component: ProjectSettings,
});

function ProjectSettings() {
  const { project, org, tokens, overrides, model, githubApp, serverUrl } = Route.useLoaderData();
  const router = useRouter();
  const hydrated = useHydrated();
  const [issued, setIssued] = useState<string | null>(null);
  const issue = async (name: string) => {
    const { token } = await issueToken({ data: { projectId: project.id, name } });
    setIssued(token);
    await router.invalidate();
  };
  return (
    <Page>
      <ListLayout
        breadcrumbs={<Breadcrumbs crumbs={[orgCrumb(org), projectCrumb(project), "Settings"]} />}
        title={`${project.name} · settings`}
      >
        <Card>
          <Stack>
            <Stack gap="xs">
              <SectionHeading>CI tokens</SectionHeading>
              <Body as="p">
                CI uploads builds with a token. It is shown once, when issued; store it as a CI
                secret.
              </Body>
            </Stack>
            {issued && (
              <Callout
                tone="warn"
                role="status"
                title="Copy this token now. It will not be shown again."
              >
                <CopyLine text={issued} data-testid="issued-token" />
              </Callout>
            )}
            <InlineForm
              label="Token name, e.g. github-actions"
              button="Issue token"
              busyLabel="Issuing…"
              emptyReason="Name the token first: where it will be used."
              onSubmit={issue}
            />
            <TokenTable tokens={tokens} hydrated={hydrated} />
          </Stack>
        </Card>
        <DefaultBranch projectId={project.id} branch={project.defaultBranch} />
        <DiffLocationForm projectId={project.id} saved={project.diffLocation} hydrated={hydrated} />
        <GithubRepo projectId={project.id} repo={project.githubRepo} appConfigured={githubApp} />
        <OverrideSettings projectId={project.id} overrides={overrides} hydrated={hydrated} />
        <IgnoreBoxSettings
          projectId={project.id}
          boxes={overrides.boxes}
          trail={overrides.boxTrail}
          hydrated={hydrated}
        />
        <ModelSettings
          scope={{ kind: "project", projectId: project.id }}
          saved={model.source === "project" ? model.model : null}
          source={model}
          orgSettingsHref={`/orgs?org=${org.id}&tab=model`}
          hydrated={hydrated}
        />
        <UploadCommand serverUrl={serverUrl} />
      </ListLayout>
    </Page>
  );
}

const LOCATIONS: { value: DiffLocation; label: string; detail: string }[] = [
  {
    value: "ci",
    label: "In CI",
    detail:
      "The CLI diffs each shot against the baseline the server picks and uploads the result; the server checks it and stores it.",
  },
  {
    value: "server",
    label: "On the server",
    detail: "The CLI uploads the shots and the server diffs them when the build is finalised.",
  },
];

/** Where the project's shots are diffed (ob 1727): one place per project, from the next build on. */
function DiffLocationForm({
  projectId,
  saved,
  hydrated,
}: {
  projectId: string;
  saved: DiffLocation;
  hydrated: boolean;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<DiffLocation>(saved);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await saveDiffLocation({ data: { projectId, location: chosen } });
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="diff-location">
      <Stack>
        <Stack gap="xs">
          <SectionHeading>Diff location</SectionHeading>
          <Body as="p">
            Where this project&apos;s shots are compared with their baselines. Every shot of a build
            is measured in the same place; a CI build whose result is missing or wrong errors, and
            is never diffed on the server instead.
          </Body>
        </Stack>
        <fieldset className="space-y-2">
          <legend className="sr-only">Diff location</legend>
          {LOCATIONS.map((l) => (
            <label key={l.value} className="flex items-start gap-2">
              <input
                type="radio"
                name="diff-location"
                value={l.value}
                checked={chosen === l.value}
                onChange={() => setChosen(l.value)}
                className="mt-1"
              />
              <span>
                <BodyStrong>{l.label}</BodyStrong>
                <span className="block">
                  <Body tone="muted">{l.detail}</Body>
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {chosen !== saved && (
          <Callout tone="warn" role="status" title="Builds will not be comparable">
            Builds before and after a switch were measured in different places and may not be
            consistent: a CI run and the server can disagree at the edges. Compare builds from the
            same side of the switch.
          </Callout>
        )}
        <ButtonGroup>
          <Button disabled={!hydrated} busy={busy} busyLabel="Saving…" onClick={() => void save()}>
            Save diff location
          </Button>
        </ButtonGroup>
      </Stack>
    </Card>
  );
}

type Token = Awaited<ReturnType<typeof getProjectSettings>>["tokens"][number];

/** Every token the project has issued: a revoked one stays listed, greyed. */
function TokenTable({ tokens, hydrated }: { tokens: Token[]; hydrated: boolean }) {
  const router = useRouter();
  const [revoking, setRevoking] = useState<string | null>(null);
  const revoke = async (tokenId: string) => {
    setRevoking(tokenId);
    try {
      await revokeToken({ data: { tokenId } });
      await router.invalidate();
    } finally {
      setRevoking(null);
    }
  };
  if (tokens.length === 0) {
    return (
      <Empty data-testid="no-tokens">No tokens yet. Issue one above, then upload with it.</Empty>
    );
  }
  return (
    <Table variant="plain" caption="Project tokens">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Token</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell>Last used</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell align="end" srLabel="Actions" />
        </TableRow>
      </TableHead>
      <TableBody>
        {tokens.map((t) => {
          const tone = t.revokedAt ? "muted" : undefined;
          return (
            <TableRow key={t.id}>
              <TableCell tone={t.revokedAt ? "muted" : "strong"}>{t.name}</TableCell>
              <TableCell mono tone={tone}>
                {t.prefix}…
              </TableCell>
              <TableCell tone={tone} title={t.createdAt.toISOString()}>
                {formatDateTime(t.createdAt)}
              </TableCell>
              <TableCell tone={tone}>
                {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "never"}
              </TableCell>
              <TableCell>
                <Pill dot tone={t.revokedAt ? "slate" : "emerald"}>
                  {t.revokedAt ? "revoked" : "active"}
                </Pill>
              </TableCell>
              <TableCell align="end">
                {!t.revokedAt && (
                  <Button
                    variant="ghost"
                    disabled={!hydrated}
                    busy={revoking === t.id}
                    busyLabel="Revoking…"
                    onClick={() => void revoke(t.id)}
                    tone="danger"
                  >
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
