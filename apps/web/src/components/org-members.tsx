import { useState } from "react";
import type { OrgInvite, OrgMember, OrgOverview } from "#/db/orgs";
import { formatDay } from "#/lib/format";
import { ActionButton } from "./action-button";
import { Avatar } from "./avatar";

function MemberRow({ member, isViewer }: { member: OrgMember; isViewer: boolean }) {
  return (
    <li
      data-testid="member-row"
      className="flex items-center gap-3 border-t border-slate-100 px-4 py-3 first:border-t-0"
    >
      <Avatar login={member.login} />
      <div className="min-w-0">
        <b className="font-semibold">{member.login}</b>
        <p className="text-[12.5px] text-slate-400">
          {[member.name, isViewer ? "you" : null].filter(Boolean).join(" · ") || " "}
        </p>
      </div>
      <span className="flex-1" />
      <span className="text-sm text-slate-400">joined {formatDay(member.joinedAt)}</span>
    </li>
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
    <li
      data-testid="invite-row"
      className="flex items-center gap-3 border-t border-slate-100 px-4 py-3"
    >
      <span
        aria-hidden="true"
        className="inline-grid h-6.5 w-6.5 shrink-0 place-items-center rounded-full bg-slate-200 text-xs font-semibold text-slate-400"
      >
        ?
      </span>
      <div className="min-w-0">
        <b className="font-semibold">{invite.githubLogin}</b>
        <p className="text-[12.5px] text-slate-400">signs in with GitHub to join</p>
      </div>
      <span className="flex-1" />
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11.5px] font-semibold text-slate-600">
        pending
      </span>
      <ActionButton
        variant="ghost"
        waiting={!hydrated}
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
        className="px-2.5 py-1 text-[13px]"
      >
        Withdraw
      </ActionButton>
    </li>
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
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = login.trim().length === 0;
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <form
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
        className="flex flex-wrap gap-2 rounded-t-xl border-b border-slate-200 bg-slate-50 px-4 py-3.5"
      >
        <input
          aria-label="Invite a member by GitHub login"
          placeholder="GitHub login to invite, e.g. octo-dev"
          value={login}
          disabled={!hydrated}
          autoComplete="off"
          onChange={(e) => setLogin(e.target.value)}
          className="h-8.5 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 hover:border-violet-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 disabled:opacity-50"
        />
        <ActionButton
          type="submit"
          waiting={!hydrated}
          disabledReason={empty ? "Type a GitHub login first." : undefined}
          busy={busy}
          busyLabel="Inviting…"
        >
          Invite
        </ActionButton>
        <p className="w-full text-xs text-slate-500" role={error ? "alert" : undefined}>
          {error ??
            (empty ? "Type a GitHub login first." : "They join when they sign in with that login.")}
        </p>
      </form>
      <ul>
        {org.members.map((member) => (
          <MemberRow key={member.userId} member={member} isViewer={member.login === viewerLogin} />
        ))}
        {org.invites.map((invite) => (
          <InviteRow key={invite.id} invite={invite} onWithdraw={onWithdraw} hydrated={hydrated} />
        ))}
      </ul>
    </div>
  );
}
