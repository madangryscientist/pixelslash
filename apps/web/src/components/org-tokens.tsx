import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Body, Callout, Input, Pill } from "@hackcove/ui";
import { formatDateTime } from "#/lib/format";
import { issueOrgTokenFn, revokeOrgTokenFn } from "#/server/org-token-fns";
import { ActionButton } from "./action-button";
import { CopyLine } from "./copy-button";

export type OrgToken = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

const HEAD = "py-2.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase";

/**
 * The org's CI tokens (ob 1787): one `psorg_` token reaches every project of the org, so a
 * monorepo's CI holds one secret, not one per package. Any member mints and revokes.
 */
export function OrgTokensPanel({
  orgId,
  orgName,
  tokens,
  hydrated,
}: {
  orgId: string;
  orgName: string;
  tokens: OrgToken[];
  hydrated: boolean;
}) {
  const [issued, setIssued] = useState<string | null>(null);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <Body as="p" className="mb-4">
        An org token lets CI reach every project in {orgName}: it creates a project by name with{" "}
        <code>pixelslash project create</code> and uploads to one with <code>--project NAME</code>.
        It is shown once, when issued. A project's own CI token, in its settings, still reaches only
        that project.
      </Body>
      {issued && (
        <Callout
          tone="warn"
          role="status"
          title="Copy this token now. It will not be shown again."
          className="mb-4"
        >
          <CopyLine text={issued} hydrated={hydrated} testId="issued-org-token" className="mt-2" />
        </Callout>
      )}
      <IssueForm orgId={orgId} onIssued={setIssued} />
      <TokenTable tokens={tokens} hydrated={hydrated} />
    </section>
  );
}

function IssueForm({ orgId, onIssued }: { orgId: string; onIssued: (token: string) => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = name.trim().length === 0;
  const emptyReason = "Name the token first: where it will be used.";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (empty) return;
    setError(null);
    setBusy(true);
    issueOrgTokenFn({ data: { orgId, name: name.trim() } })
      .then(async ({ token }) => {
        onIssued(token);
        setName("");
        await router.invalidate();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="Org token name, e.g. monorepo CI"
        placeholder="Token name, e.g. monorepo CI"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="min-w-0 flex-1 px-3"
      />
      <ActionButton
        type="submit"
        disabledReason={empty ? emptyReason : undefined}
        busy={busy}
        busyLabel="Issuing…"
      >
        Issue org token
      </ActionButton>
      {error ? (
        <p role="alert" className="w-full text-sm text-red-700">
          {error}
        </p>
      ) : (
        empty && <p className="w-full text-xs text-slate-400">{emptyReason}</p>
      )}
    </form>
  );
}

/** Every token of the org: a revoked one stays listed, greyed. */
function TokenTable({ tokens, hydrated }: { tokens: OrgToken[]; hydrated: boolean }) {
  const router = useRouter();
  const [revoking, setRevoking] = useState<string | null>(null);
  const revoke = async (tokenId: string) => {
    setRevoking(tokenId);
    try {
      await revokeOrgTokenFn({ data: { tokenId } });
      await router.invalidate();
    } finally {
      setRevoking(null);
    }
  };
  if (tokens.length === 0) {
    return (
      <p data-testid="no-org-tokens" className="mt-6 text-sm text-slate-400">
        No org tokens yet. Issue one above to use a single secret across a monorepo's CI.
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
        {tokens.map((t) => {
          const active = !t.revokedAt;
          return (
            <tr key={t.id} data-testid="org-token-row" className={active ? "" : "text-slate-400"}>
              <td className="py-3 pr-3 font-medium">{t.name}</td>
              <td className="pr-3 font-mono text-[12.5px] text-slate-600">{t.prefix}…</td>
              <td className="pr-3 whitespace-nowrap text-slate-600">
                {formatDateTime(t.createdAt)}
              </td>
              <td className="pr-3 whitespace-nowrap text-slate-600">
                {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "never"}
              </td>
              <td className="pr-3">
                <Pill dot tone={active ? "emerald" : "slate"}>
                  {active ? "active" : "revoked"}
                </Pill>
              </td>
              <td className="text-right">
                {active && (
                  <ActionButton
                    variant="ghost"
                    waiting={!hydrated}
                    busy={revoking === t.id}
                    busyLabel="Revoking…"
                    onClick={() => void revoke(t.id)}
                    className="text-red-700!"
                    aria-label={`Revoke ${t.name}`}
                  >
                    Revoke
                  </ActionButton>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
