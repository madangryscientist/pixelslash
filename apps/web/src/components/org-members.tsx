import {
  Avatar,
  Body,
  BodyStrong,
  Button,
  Caption,
  Card,
  Cluster,
  Input,
  ListRow,
  Pill,
  Stack,
} from "@hackcove/ui";
import { useState } from "react";
import type { OrgInvite, OrgMember, OrgOverview } from "#/db/orgs";
import { formatDay } from "#/lib/format";

function MemberRow({
  member,
  isViewer,
  divided,
}: {
  member: OrgMember;
  isViewer: boolean;
  divided: boolean;
}) {
  return (
    <ListRow
      static
      data-testid="member-row"
      divided={divided}
      leading={<Avatar name={member.login} />}
      trailing={<Body tone="muted">joined {formatDay(member.joinedAt)}</Body>}
    >
      <BodyStrong as="b">{member.login}</BodyStrong>
      <Caption as="p">
        {[member.name, isViewer ? "you" : null].filter(Boolean).join(" · ") || " "}
      </Caption>
    </ListRow>
  );
}

function InviteRow({
  invite,
  onWithdraw,
  hydrated,
}: {
  invite: OrgInvite;
  onWithdraw: (invite: OrgInvite) => Promise<unknown>;
  hydrated: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ListRow
      static
      data-testid="invite-row"
      divided
      leading={<Avatar name="?" />}
      trailing={
        <Cluster gap="sm">
          {error && (
            <Caption role="alert" tone="danger">
              {error}
            </Caption>
          )}
          <Pill>pending</Pill>
        </Cluster>
      }
      actions={
        <Button
          variant="ghost"
          disabled={!hydrated}
          busy={busy}
          busyLabel="Withdrawing…"
          aria-label={`Withdraw invite for ${invite.githubLogin}`}
          onClick={() => {
            setBusy(true);
            setError(null);
            onWithdraw(invite).then(undefined, (e: unknown) => {
              setBusy(false);
              setError(e instanceof Error ? e.message : String(e));
            });
          }}
          size="sm"
        >
          Withdraw
        </Button>
      }
    >
      <BodyStrong as="b">{invite.githubLogin}</BodyStrong>
      <Caption as="p">signs in with GitHub to join</Caption>
    </ListRow>
  );
}

/** One field that sends an invite, with why it is grey or what happens next under it. */
function InviteForm({
  hydrated,
  onInvite,
}: {
  hydrated: boolean;
  onInvite: (login: string) => Promise<unknown>;
}) {
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = login.trim().length === 0;
  return (
    <Stack
      as="form"
      gap="xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (empty || busy) return;
        setError(null);
        setBusy(true);
        void onInvite(login.trim()).then(
          () => {
            setLogin("");
            setBusy(false);
          },
          (e: unknown) => {
            setBusy(false);
            setError(e instanceof Error ? e.message : String(e));
          },
        );
      }}
    >
      <Cluster gap="sm" wrap>
        <Input
          aria-label="Invite a member by GitHub login"
          placeholder="GitHub login to invite, e.g. octo-dev"
          value={login}
          disabled={!hydrated}
          autoComplete="off"
          onChange={(e) => setLogin(e.target.value)}
          width="lg"
        />
        <Button
          type="submit"
          disabled={!hydrated}
          disabledReason={empty ? "Type a GitHub login first." : undefined}
          busy={busy}
          busyLabel="Inviting…"
        >
          Invite
        </Button>
      </Cluster>
      {error ? (
        <Body as="p" role="alert" tone="danger">
          {error}
        </Body>
      ) : (
        <Caption as="p">
          {empty ? "Type a GitHub login first." : "They join when they sign in with that login."}
        </Caption>
      )}
    </Stack>
  );
}

/** The members, then the invites nobody has taken up yet, under one field that sends an invite. */
export function MembersPanel({
  org,
  viewerLogin,
  hydrated,
  onInvite,
  onWithdraw,
}: {
  org: OrgOverview;
  viewerLogin: string | null;
  hydrated: boolean;
  onInvite: (login: string) => Promise<unknown>;
  onWithdraw: (invite: OrgInvite) => Promise<unknown>;
}) {
  return (
    <Stack gap="md">
      <InviteForm hydrated={hydrated} onInvite={onInvite} />
      <Card flush>
        {org.members.map((member, index) => (
          <MemberRow
            key={member.userId}
            member={member}
            isViewer={member.login === viewerLogin}
            divided={index > 0}
          />
        ))}
        {org.invites.map((invite) => (
          <InviteRow key={invite.id} invite={invite} onWithdraw={onWithdraw} hydrated={hydrated} />
        ))}
      </Card>
    </Stack>
  );
}
