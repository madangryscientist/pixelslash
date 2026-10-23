import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
  Body,
  Breadcrumbs,
  Callout,
  Input,
  ListLayout,
  Pill,
  SectionHeading,
  Select,
} from "@hackcove/ui";
import { ActionButton } from "#/components/action-button";
import { CopyLine } from "#/components/copy-button";
import { Page, useHydrated } from "#/components/ui";
import { formatDateTime } from "#/lib/format";
import { TOKEN_EXPIRY_DAYS } from "#/lib/token-expiry";
import { getAccountSettings, issuePersonalToken, revokePersonalToken } from "#/server/account";

export const Route = createFileRoute("/settings")({
  loader: () => getAccountSettings(),
  component: AccountSettings,
});

const HEAD = "py-2.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase";

/** The signed-in user's own settings: for now, the personal API tokens the CLI and MCP act with (ob 1728). */
function AccountSettings() {
  const { tokens, now, serverUrl } = Route.useLoaderData();
  const hydrated = useHydrated();
  const [issued, setIssued] = useState<string | null>(null);
  return (
    <Page>
      <ListLayout breadcrumbs={<Breadcrumbs crumbs={["Settings"]} />} title="Settings">
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <SectionHeading className="mb-1.5">API tokens</SectionHeading>
          <Body as="p" className="mb-4">
            The CLI and MCP server act as you with a personal token: they see the organizations and
            projects you see here. It is shown once, when issued. For CI, issue a project's CI token
            in its settings instead.
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
          <IssueForm onIssued={setIssued} />
          <TokenTable tokens={tokens} now={now} hydrated={hydrated} />
          <Body as="p" className="mt-6 mb-3">
            Check a token from your machine with:
          </Body>
          <CopyLine
            text={`curl -H "Authorization: Bearer $PIXELSLASH_TOKEN" ${serverUrl}/api/v1/me`}
            hydrated={hydrated}
            testId="token-usage"
          />
        </section>
      </ListLayout>
    </Page>
  );
}

/** A name and a lifetime; the button stays grey until the token is named. */
function IssueForm({ onIssued }: { onIssued: (token: string) => void }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = name.trim().length === 0;
  const emptyReason = "Name the token first: where it will be used.";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (empty) return;
    setError(null);
    setBusy(true);
    issuePersonalToken({
      data: { name: name.trim(), days: days === "never" ? null : Number(days) },
    })
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
        aria-label="Token name, e.g. laptop"
        placeholder="Token name, e.g. laptop"
        value={name}
        disabled={!hydrated}
        onChange={(e) => setName(e.target.value)}
        className="min-w-0 flex-1 px-3"
      />
      <Select
        aria-label="Expires"
        value={days}
        disabled={!hydrated}
        onChange={(e) => setDays(e.target.value)}
        className="w-auto! px-3"
      >
        {TOKEN_EXPIRY_DAYS.map((d) => (
          <option key={d} value={String(d)}>
            {d === 365 ? "Expires in 1 year" : `Expires in ${d} days`}
          </option>
        ))}
        <option value="never">Never expires</option>
      </Select>
      <ActionButton
        type="submit"
        waiting={!hydrated}
        disabledReason={empty ? emptyReason : undefined}
        busy={busy}
        busyLabel="Issuing…"
      >
        Issue token
      </ActionButton>
      {error ? (
        <p role="alert" className="w-full text-sm text-red-700">
          {error}
        </p>
      ) : (
        empty && hydrated && <p className="w-full text-xs text-slate-400">{emptyReason}</p>
      )}
    </form>
  );
}

type Token = Awaited<ReturnType<typeof getAccountSettings>>["tokens"][number];

function stateOf(token: Token, now: Date): "revoked" | "expired" | "active" {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && token.expiresAt <= now) return "expired";
  return "active";
}

/** Every token the user has issued: a revoked or expired one stays listed, greyed. */
function TokenTable({ tokens, now, hydrated }: { tokens: Token[]; now: Date; hydrated: boolean }) {
  const router = useRouter();
  const [revoking, setRevoking] = useState<string | null>(null);
  const revoke = async (tokenId: string) => {
    setRevoking(tokenId);
    try {
      await revokePersonalToken({ data: { tokenId } });
      await router.invalidate();
    } finally {
      setRevoking(null);
    }
  };
  if (tokens.length === 0) {
    return (
      <p data-testid="no-tokens" className="mt-6 text-sm text-slate-400">
        No tokens yet. Issue one above to use the CLI or MCP server as yourself.
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
          <th className={HEAD}>Expires</th>
          <th className={HEAD}>Status</th>
          <th />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {tokens.map((t) => {
          const state = stateOf(t, now);
          return (
            <tr key={t.id} className={state === "active" ? "" : "text-slate-400"}>
              <td className="py-3 pr-3 font-medium">{t.name}</td>
              <td className="pr-3 font-mono text-[12.5px] text-slate-600">{t.prefix}…</td>
              <td className="pr-3 whitespace-nowrap text-slate-600">
                {formatDateTime(t.createdAt)}
              </td>
              <td className="pr-3 whitespace-nowrap text-slate-600">
                {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "never"}
              </td>
              <td className="pr-3 whitespace-nowrap text-slate-600">
                {t.expiresAt ? formatDateTime(t.expiresAt) : "never"}
              </td>
              <td className="pr-3">
                <Pill dot tone={state === "active" ? "emerald" : "slate"}>
                  {state}
                </Pill>
              </td>
              <td className="text-right">
                {state === "active" && (
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
