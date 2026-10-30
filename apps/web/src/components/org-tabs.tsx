import { AvatarStack, Button, Cluster, type LinkRenderProps, PageHeader, Tabs } from "@hackcove/ui";
import { Link } from "@tanstack/react-router";
import type { OrgOverview } from "#/db/orgs";
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
        <Cluster as="span" gap="sm">
          <AvatarStack
            people={org.members.map((member) => ({ name: member.login }))}
            max={4}
            size="md"
            aria-hidden="true"
          />
          <span data-testid="org-people">
            {plural(org.members.length, "member")}
            {" · "}
            {pending} {pending === 1 ? "invite" : "invites"} pending
          </span>
        </Cluster>
      }
      actions={
        <>
          <Button variant="outline" disabled={!hydrated} onClick={() => onDialog("invite")}>
            Invite
          </Button>
          <Button disabled={!hydrated} onClick={() => onDialog("project")}>
            + New project
          </Button>
        </>
      }
      tabs={<OrgTabs org={org} tab={tab} />}
    />
  );
}

export type Tab = "projects" | "members" | "tokens" | "model" | "timings";

function OrgTabs({ org, tab }: { org: OrgOverview; tab: Tab }) {
  const to = (target: Exclude<Tab, "projects"> | undefined) => (props: LinkRenderProps) => (
    <Link to="/orgs" search={target ? { org: org.id, tab: target } : { org: org.id }} {...props} />
  );
  return (
    <Tabs
      variant="pill"
      label="Organization"
      value={tab}
      items={[
        { value: "projects", label: "Projects", count: org.projects.length, render: to(undefined) },
        { value: "members", label: "Members", count: org.members.length, render: to("members") },
        { value: "tokens", label: "Tokens", render: to("tokens") },
        { value: "model", label: "AI model", render: to("model") },
        { value: "timings", label: "Timings", render: to("timings") },
      ]}
    />
  );
}
