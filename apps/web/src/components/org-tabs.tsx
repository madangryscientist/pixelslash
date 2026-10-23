import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { OrgOverview } from "#/db/orgs";
import { ActionButton } from "./action-button";
import { Avatar } from "./avatar";
import { plural } from "./org-projects";

/** The header's two buttons; the page owns the dialogs they open. */
export type DialogKind = "project" | "org" | "invite";

/** The org's name, who is in it, and the two things you do from any tab. */
export function OrgHeader({
  org,
  hydrated,
  onDialog,
}: {
  org: OrgOverview;
  hydrated: boolean;
  onDialog: (kind: DialogKind) => void;
}) {
  const pending = org.invites.length;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
      <h1 className="text-2xl font-bold tracking-tight">{org.name}</h1>
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <span className="flex" aria-hidden="true">
          {org.members.slice(0, 4).map((member) => (
            <Avatar key={member.userId} login={member.login} ring />
          ))}
        </span>
        <span data-testid="org-people">
          {plural(org.members.length, "member")}
          {" · "}
          {pending} {pending === 1 ? "invite" : "invites"} pending
        </span>
      </div>
      <span className="flex-1" />
      <ActionButton variant="outline" waiting={!hydrated} onClick={() => onDialog("invite")}>
        Invite
      </ActionButton>
      <ActionButton waiting={!hydrated} onClick={() => onDialog("project")}>
        + New project
      </ActionButton>
    </div>
  );
}

const TAB =
  "-mb-px border-b-2 px-0.5 pb-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600";

export type Tab = "projects" | "members" | "tokens" | "model";

function TabLink({
  org,
  tab,
  current,
  children,
}: {
  org: OrgOverview;
  tab: Exclude<Tab, "projects"> | undefined;
  current: Tab;
  children: ReactNode;
}) {
  const active = current === (tab ?? "projects");
  return (
    <Link
      to="/orgs"
      search={tab ? { org: org.id, tab } : { org: org.id }}
      aria-current={active ? "page" : undefined}
      className={`${TAB} ${active ? "border-violet-600 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"}`}
    >
      {children}
    </Link>
  );
}

export function OrgTabs({ org, tab }: { org: OrgOverview; tab: Tab }) {
  return (
    <nav aria-label="Organization" className="mb-5 flex gap-6 border-b border-slate-200">
      <TabLink org={org} tab={undefined} current={tab}>
        Projects <span className="ml-1 text-slate-400">{org.projects.length}</span>
      </TabLink>
      <TabLink org={org} tab="members" current={tab}>
        Members <span className="ml-1 text-slate-400">{org.members.length}</span>
      </TabLink>
      <TabLink org={org} tab="tokens" current={tab}>
        Tokens
      </TabLink>
      <TabLink org={org} tab="model" current={tab}>
        AI model
      </TabLink>
    </nav>
  );
}
