import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Body, Callout, Pill, SectionHeading } from "@hackcove/ui";
import { ActionButton } from "#/components/action-button";
import { CopyLine } from "#/components/copy-button";
import { orgCrumb, projectCrumb } from "#/components/crumbs";
import { InlineForm, Page, useHydrated } from "#/components/ui";
import { formatDateTime } from "#/lib/format";
import { getProjectSettings, issueToken, revokeToken } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/settings")({
  loader: ({ params }) => getProjectSettings({ data: { projectId: params.projectId } }),
  component: ProjectSettings,
});

const HEAD = "py-2.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase";

function ProjectSettings() {
  const { project, org, tokens, serverUrl } = Route.useLoaderData();
  const router = useRouter();
  const hydrated = useHydrated();
  const [issued, setIssued] = useState<string | null>(null);
  const issue = async (name: string) => {
    const { token } = await issueToken({ data: { projectId: project.id, name } });
    setIssued(token);
    await router.invalidate();
  };
  return (
    <Page
      title={`${project.name} · settings`}
      crumbs={[orgCrumb(org), projectCrumb(project), "Settings"]}
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
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
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
    </Page>
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
    <table className="mt-6 w-full text-left text-sm">
      <thead>
        <tr className="border-b border-slate-200">
          <th className={HEAD}>Name</th>
          <th className={HEAD}>Token</th>
          <th className={HEAD}>Created</th>
          <th className={HEAD}>Last used</th>
          <th className={HEAD}>Status</th>
          <th />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {tokens.map((t) => (
          <tr key={t.id} className={t.revokedAt ? "text-slate-400" : ""}>
            <td className="py-3 pr-3 font-medium">{t.name}</td>
            <td className="pr-3 font-mono text-[12.5px] text-slate-600">{t.prefix}…</td>
            <td className="pr-3 whitespace-nowrap text-slate-600" title={t.createdAt.toISOString()}>
              {formatDateTime(t.createdAt)}
            </td>
            <td className="pr-3 whitespace-nowrap text-slate-600">
              {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "never"}
            </td>
            <td className="pr-3">
              <Pill dot tone={t.revokedAt ? "slate" : "emerald"}>
                {t.revokedAt ? "revoked" : "active"}
              </Pill>
            </td>
            <td className="text-right">
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
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
