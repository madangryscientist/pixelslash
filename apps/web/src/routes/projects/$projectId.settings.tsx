import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Body,
  Breadcrumbs,
  Callout,
  ListLayout,
  Pill,
  SectionHeading,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@hackcove/ui";
import { ActionButton } from "#/components/action-button";
import { CopyLine } from "#/components/copy-button";
import { orgCrumb, projectCrumb } from "#/components/crumbs";
import { IgnoreBoxSettings } from "#/components/ignore-box-settings";
import { ModelSettings } from "#/components/model-settings";
import { OverrideSettings } from "#/components/override-trail";
import { InlineForm, Page, useHydrated } from "#/components/ui";
import { formatDateTime } from "#/lib/format";
import type { DiffLocation } from "#/db/schema";
import {
  getProjectSettings,
  issueToken,
  revokeToken,
  saveDefaultBranch,
  saveDiffLocation,
} from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/settings")({
  loader: ({ params }) => getProjectSettings({ data: { projectId: params.projectId } }),
  component: ProjectSettings,
});

function ProjectSettings() {
  const { project, org, tokens, overrides, model, serverUrl } = Route.useLoaderData();
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
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <SectionHeading className="mb-1.5">CI tokens</SectionHeading>
          <Body as="p" className="mb-4">
            CI uploads builds with a token. It is shown once, when issued; store it as a CI secret.
          </Body>
          {issued && (
            <Callout
              tone="warn"
              role="status"
              title="Copy this token now. It will not be shown again."
              className="mb-4"
            >
              <CopyLine text={issued} hydrated={hydrated} testId="issued-token" className="mt-2" />
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
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <SectionHeading className="mb-1.5">Default branch</SectionHeading>
          <Body as="p" className="mb-4">
            Builds on this branch are accepted without review and become the baseline for branch
            builds. Builds on other branches wait for review.
          </Body>
          <InlineForm
            label="Default branch, e.g. main"
            button="Save"
            busyLabel="Saving…"
            emptyReason="Name the branch: the one you merge into."
            initialValue={project.defaultBranch}
            onSubmit={async (branch) => {
              await saveDefaultBranch({ data: { projectId: project.id, branch } });
              await router.invalidate();
            }}
          />
        </section>
        <DiffLocationForm projectId={project.id} saved={project.diffLocation} hydrated={hydrated} />
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
        <UploadCommand serverUrl={serverUrl} hydrated={hydrated} />
      </ListLayout>
    </Page>
  );
}

function UploadCommand({ serverUrl, hydrated }: { serverUrl: string; hydrated: boolean }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <SectionHeading className="mb-1.5">Upload a build</SectionHeading>
      <Body as="p" className="mb-3">
        From CI or your machine, with the token in{" "}
        <span className="font-mono text-[13px]">PIXELSLASH_TOKEN</span>:
      </Body>
      <CopyLine
        text={`PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}`}
        hydrated={hydrated}
        testId="upload-command"
      />
    </section>
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
    <section
      className="rounded-xl border border-slate-200 bg-white p-6"
      data-testid="diff-location"
    >
      <SectionHeading className="mb-1.5">Diff location</SectionHeading>
      <Body as="p" className="mb-4">
        Where this project&apos;s shots are compared with their baselines. Every shot of a build is
        measured in the same place; a CI build whose result is missing or wrong errors, and is never
        diffed on the server instead.
      </Body>
      <fieldset className="mb-4 space-y-2">
        <legend className="sr-only">Diff location</legend>
        {LOCATIONS.map((l) => (
          <label key={l.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="diff-location"
              value={l.value}
              checked={chosen === l.value}
              onChange={() => setChosen(l.value)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{l.label}</span>
              <span className="block text-slate-600">{l.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {chosen !== saved && (
        <Callout tone="warn" role="status" title="Builds will not be comparable" className="mb-4">
          Builds before and after a switch were measured in different places and may not be
          consistent: a CI run and the server can disagree at the edges. Compare builds from the
          same side of the switch.
        </Callout>
      )}
      <ActionButton waiting={!hydrated} busy={busy} busyLabel="Saving…" onClick={() => void save()}>
        Save diff location
      </ActionButton>
    </section>
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
      <p data-testid="no-tokens" className="mt-6 text-sm text-slate-400">
        No tokens yet. Issue one above, then upload with it.
      </p>
    );
  }
  return (
    <Table variant="plain" caption="Project tokens" className="mt-6">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Token</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell>Last used</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell align="end">
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
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
                  <ActionButton
                    variant="ghost"
                    waiting={!hydrated}
                    busy={revoking === t.id}
                    busyLabel="Revoking…"
                    onClick={() => void revoke(t.id)}
                    className="text-red-700!"
                  >
                    Revoke
                  </ActionButton>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
