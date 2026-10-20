import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { InlineForm, Page, useHydrated } from "#/components/ui";
import { getProjectSettings, issueToken, revokeToken } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/settings")({
  loader: ({ params }) => getProjectSettings({ data: { projectId: params.projectId } }),
  component: ProjectSettings,
});

function ProjectSettings() {
  const { project, tokens } = Route.useLoaderData();
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
    <Page title={`${project.name} · settings`}>
      <h2 className="mb-2 text-lg font-semibold">CI tokens</h2>
      <p className="mb-4 text-sm text-neutral-600">
        CI uploads builds with a token. It is shown once, when issued; store it as a CI secret.
      </p>
      {issued && (
        <div role="status" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium">Copy this token now. It will not be shown again.</p>
          <code data-testid="issued-token" className="mt-1 block break-all text-sm">
            {issued}
          </code>
        </div>
      )}
      <InlineForm label="Token name, e.g. github-actions" button="Issue token" onSubmit={issue} />
      <table className="mt-6 w-full text-left text-sm">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-2">Name</th>
            <th>Token</th>
            <th>Created</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {tokens.map((t) => (
            <tr key={t.id}>
              <td className="py-2">{t.name}</td>
              <td className="font-mono">{t.prefix}…</td>
              <td>{t.createdAt.toLocaleDateString()}</td>
              <td>{t.revokedAt ? "revoked" : "active"}</td>
              <td className="text-right">
                {!t.revokedAt && (
                  <button
                    type="button"
                    disabled={!hydrated}
                    onClick={() => void revoke(t.id)}
                    className="text-red-700 hover:underline"
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
