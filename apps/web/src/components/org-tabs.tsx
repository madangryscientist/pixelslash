import { PageHeader, navTabClass } from "@hackcove/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { OrgOverview } from "#/db/orgs";
import { ActionButton } from "./action-button";
import { Avatar } from "./avatar";
import { plural } from "./org-projects";

/** The header's two buttons; the page owns the dialogs they open. */
export type DialogKind = "project" | "org" | "invite";

/** The org's name, who is in it, the two things you do from any tab, and the tabs. */
export function OrgHeader({
  org,
  tab,
  hydrated,
  onDialog,
}: {
  org: OrgOverview;
  tab: Tab;
  hydrated: boolean;
  onDialog: (kind: DialogKind) => void;
}) {
  const pending = org.invites.length;
  return (
    <PageHeader
      title={org.name}
      subtitle={
        <span className="flex items-center gap-3">
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
        </span>
      }
      actions={
        <>
          <ActionButton variant="outline" waiting={!hydrated} onClick={() => onDialog("invite")}>
            Invite
          </ActionButton>
          <ActionButton waiting={!hydrated} onClick={() => onDialog("project")}>
            + New project
          </ActionButton>
        </>
      }
      tabs={<OrgTabs org={org} tab={tab} />}
    />
  );
}

export type Tab = "projects" | "members" | "tokens" | "model" | "timings";

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
      className={navTabClass(active)}
    >
      {children}
    </Link>
  );
}

function OrgTabs({ org, tab }: { org: OrgOverview; tab: Tab }) {
  return (
    <nav aria-label="Organization" className="flex flex-wrap gap-1 text-sm">
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
      <TabLink org={org} tab="timings" current={tab}>
        Timings
      </TabLink>
    </nav>
  );
}
