import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
  Body,
  Breadcrumbs,
  Button,
  Callout,
  Caption,
  Card,
  Cluster,
  CopyLine,
  Input,
  ListLayout,
  Pill,
  SectionHeading,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@hackcove/ui";
import { Page, useHydrated } from "#/components/ui";
import { formatDateTime } from "#/lib/format";
import { TOKEN_EXPIRY_DAYS } from "#/lib/token-expiry";
import { getAccountSettings, issuePersonalToken, revokePersonalToken } from "#/server/account";

export const Route = createFileRoute("/settings")({
  loader: () => getAccountSettings(),
  component: AccountSettings,
});

/** The signed-in user's own settings: for now, the personal API tokens the CLI and MCP act with (ob 1728). */
function AccountSettings() {
  const { tokens, now, serverUrl } = Route.useLoaderData();
  const hydrated = useHydrated();
  const [issued, setIssued] = useState<string | null>(null);
  return (
    <Page>
      <ListLayout breadcrumbs={<Breadcrumbs crumbs={["Settings"]} />} title="Settings">
        <Card>
          <Stack>
            <Stack gap="xs">
              <SectionHeading>API tokens</SectionHeading>
              <Body as="p">
                The CLI and MCP server act as you with a personal token: they see the organizations
                and projects you see here. It is shown once, when issued. For CI, issue a project's
                CI token in its settings instead.
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
            <IssueForm onIssued={setIssued} />
            <TokenTable tokens={tokens} now={now} hydrated={hydrated} />
            <Stack gap="sm">
              <Body as="p">Check a token from your machine with:</Body>
              <CopyLine
                text={`curl -H "Authorization: Bearer $PIXELSLASH_TOKEN" ${serverUrl}/api/v1/me`}
                disabled={!hydrated}
                data-testid="token-usage"
              />
            </Stack>
          </Stack>
        </Card>
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
    <Stack as="form" gap="xs" onSubmit={submit}>
      <Cluster gap="sm" wrap>
        <Input
          aria-label="Token name, e.g. laptop"
          placeholder="Token name, e.g. laptop"
          value={name}
          disabled={!hydrated}
          onChange={(e) => setName(e.target.value)}
          width="lg"
        />
        <Select
          aria-label="Expires"
          value={days}
          disabled={!hydrated}
          onChange={(e) => setDays(e.target.value)}
          width="auto"
        >
          {TOKEN_EXPIRY_DAYS.map((d) => (
            <option key={d} value={String(d)}>
              {d === 365 ? "Expires in 1 year" : `Expires in ${d} days`}
            </option>
          ))}
          <option value="never">Never expires</option>
        </Select>
        <Button
          type="submit"
          disabled={!hydrated}
          disabledReason={empty ? emptyReason : undefined}
          busy={busy}
          busyLabel="Issuing…"
        >
          Issue token
        </Button>
      </Cluster>
      {error ? (
        <Body as="p" role="alert" tone="danger">
          {error}
        </Body>
      ) : (
        empty && hydrated && <Caption as="p">{emptyReason}</Caption>
      )}
    </Stack>
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
      <Body as="p" tone="muted" data-testid="no-tokens">
        No tokens yet. Issue one above to use the CLI or MCP server as yourself.
      </Body>
    );
  }
  return (
    <Table variant="plain" caption="Personal tokens">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Token</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell>Last used</TableHeaderCell>
          <TableHeaderCell>Expires</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell align="end" srLabel="Actions" />
        </TableRow>
      </TableHead>
      <TableBody>
        {tokens.map((t) => {
          const state = stateOf(t, now);
          const active = state === "active";
          const tone = active ? undefined : "muted";
          return (
            <TableRow key={t.id}>
              <TableCell tone={active ? "strong" : "muted"}>{t.name}</TableCell>
              <TableCell mono tone={tone}>
                {t.prefix}…
              </TableCell>
              <TableCell tone={tone}>{formatDateTime(t.createdAt)}</TableCell>
              <TableCell tone={tone}>
                {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "never"}
              </TableCell>
              <TableCell tone={tone}>
                {t.expiresAt ? formatDateTime(t.expiresAt) : "never"}
              </TableCell>
              <TableCell>
                <Pill dot tone={active ? "emerald" : "slate"}>
                  {state}
                </Pill>
              </TableCell>
              <TableCell align="end">
                {active && (
                  <Button
                    variant="ghost"
                    disabled={!hydrated}
                    busy={revoking === t.id}
                    busyLabel="Revoking…"
                    onClick={() => void revoke(t.id)}
                    tone="danger"
                    aria-label={`Revoke ${t.name}`}
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
