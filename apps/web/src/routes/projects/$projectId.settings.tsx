import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Body, Callout, SectionHeading } from "@hackcove/ui";
import { orgCrumb, projectCrumb } from "#/components/crumbs";
import { InlineForm, Page, useHydrated } from "#/components/ui";
import { getProjectSettings, issueToken, revokeToken } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/settings")({
  loader: ({ params }) => getProjectSettings({ data: { projectId: params.projectId } }),
  component: ProjectSettings,
});

function ProjectSettings() {
  const { project, org, tokens } = Route.useLoaderData();
  const router = useRouter();
  const hydrated = useHydrated();
  const [issued, setIssued] = useState<string | null>(null);
  const issue = async (name: string) => {
    const { token } = await issueToken({ data: { projectId: project.id, name } });
    setIssued(token);
    await router.invalidate();
  };
  const revoke = async (tokenId: string) => {
    await revokeToken({ data: { tokenId } });
    await router.invalidate();
  };
  return (
    <Page
      title={`${project.name} · settings`}
      crumbs={[orgCrumb(org), projectCrumb(project), "Settings"]}
    >
      <SectionHeading className="mb-2">CI tokens</SectionHeading>
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
          <code data-testid="issued-token" className="block break-all font-mono text-sm">
            {issued}
          </code>
        </Callout>
      )}
      <InlineForm label="Token name, e.g. github-actions" button="Issue token" onSubmit={issue} />
      <table className="mt-6 w-full text-left text-sm">
        <thead className="text-slate-500">
          <tr>
            <th className="py-2">Name</th>
            <th>Token</th>
            <th>Created</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {tokens.map((t) => (
            <tr key={t.id}>
              <td className="py-2">{t.name}</td>
              <td className="font-mono text-slate-600">{t.prefix}…</td>
              <td>{t.createdAt.toLocaleDateString()}</td>
              <td>{t.revokedAt ? "revoked" : "active"}</td>
              <td className="text-right">
                {!t.revokedAt && (
                  <button
                    type="button"
                    disabled={!hydrated}
                    onClick={() => void revoke(t.id)}
                    className="rounded text-red-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
