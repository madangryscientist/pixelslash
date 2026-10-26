import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
  Body,
  Button,
  Callout,
  Caption,
  Card,
  Cluster,
  Code,
  CopyLine,
  Input,
  Pill,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@hackcove/ui";
import { formatDateTime } from "#/lib/format";
import { issueOrgTokenFn, revokeOrgTokenFn } from "#/server/org-token-fns";

export type OrgToken = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

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
    <Card>
      <Stack>
        <Body as="p">
          An org token lets CI reach every project in {orgName}: it creates a project by name with{" "}
          <Code>pixelslash project create</Code> and uploads to one with <Code>--project NAME</Code>
          . It is shown once, when issued. A project's own CI token, in its settings, still reaches
          only that project.
        </Body>
        {issued && (
          <Callout
            tone="warn"
            role="status"
            title="Copy this token now. It will not be shown again."
          >
            <CopyLine text={issued} data-testid="issued-org-token" />
          </Callout>
        )}
        <IssueForm orgId={orgId} onIssued={setIssued} />
        <TokenTable tokens={tokens} hydrated={hydrated} />
      </Stack>
    </Card>
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
    <Stack as="form" gap="xs" onSubmit={submit}>
      <Cluster gap="sm" wrap>
        <Input
          aria-label="Org token name, e.g. monorepo CI"
          placeholder="Token name, e.g. monorepo CI"
          value={name}
          onChange={(e) => setName(e.target.value)}
          width="lg"
        />
        <Button
          type="submit"
          disabledReason={empty ? emptyReason : undefined}
          busy={busy}
          busyLabel="Issuing…"
        >
          Issue org token
        </Button>
      </Cluster>
      {error ? (
        <Body as="p" role="alert" tone="danger">
          {error}
        </Body>
      ) : (
        empty && <Caption as="p">{emptyReason}</Caption>
      )}
    </Stack>
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
      <Body as="p" tone="muted" data-testid="no-org-tokens">
        No org tokens yet. Issue one above to use a single secret across a monorepo's CI.
      </Body>
    );
  }
  return (
    <Table variant="plain" caption="Org tokens">
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
          const active = !t.revokedAt;
          const tone = active ? undefined : "muted";
          return (
            <TableRow key={t.id} data-testid="org-token-row">
              <TableCell tone={active ? "strong" : "muted"}>{t.name}</TableCell>
              <TableCell mono tone={tone}>
                {t.prefix}…
              </TableCell>
              <TableCell tone={tone}>{formatDateTime(t.createdAt)}</TableCell>
              <TableCell tone={tone}>
                {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "never"}
              </TableCell>
              <TableCell>
                <Pill dot tone={active ? "emerald" : "slate"}>
                  {active ? "active" : "revoked"}
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
