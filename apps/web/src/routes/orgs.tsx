import { SidebarLayout } from "@hackcove/ui";
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ActionButton } from "#/components/action-button";
import { FieldDialog } from "#/components/dialog";
import { ModelSettings } from "#/components/model-settings";
import { MembersPanel } from "#/components/org-members";
import { type OrgToken, OrgTokensPanel } from "#/components/org-tokens";
import { EmptyOrg } from "#/components/org-empty";
import { ProjectTable, WaitingStrip } from "#/components/org-projects";
import { type DialogKind, OrgHeader, type Tab } from "#/components/org-tabs";
import { OrgRail } from "#/components/org-rail";
import { Page, useHydrated } from "#/components/ui";
import type { ModelView } from "#/db/models";
import type { OrgOverview } from "#/db/orgs";
import { getOrgs, invite, newOrg, newProject, withdrawOrgInvite } from "#/server/fns";

type OrgsSearch = { org?: string; tab?: "members" | "tokens" | "model" };

const rootRoute = getRouteApi("__root__");

export const Route = createFileRoute("/orgs")({
  validateSearch: (search: Record<string, unknown>): OrgsSearch => {
    const out: OrgsSearch = {};
    if (typeof search.org === "string" && search.org) out.org = search.org;
    if (search.tab === "members" || search.tab === "tokens" || search.tab === "model")
      out.tab = search.tab;
    return out;
  },
  loader: () => getOrgs(),
  component: Orgs,
});

function Orgs() {
  const { orgs, orgTokens, orgModels, now, serverUrl } = Route.useLoaderData();
  const search = Route.useSearch();
  const { viewer } = rootRoute.useLoaderData();
  const router = useRouter();
  const hydrated = useHydrated();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const refresh = () => router.invalidate();
  const selected = orgs.find((org) => org.id === search.org) ?? orgs[0] ?? null;
  const onInvite = (login: string) =>
    selected ? invite({ data: { orgId: selected.id, login } }).then(refresh) : Promise.resolve();

  return (
    <Page bleed>
      <SidebarLayout
        rail={
          <OrgRail
            orgs={orgs}
            selectedId={selected?.id ?? null}
            onNew={() => setDialog("org")}
            hydrated={hydrated}
          />
        }
      >
        {selected ? (
          <OrgPanel
            org={selected}
            tokens={orgTokens.filter((t) => t.orgId === selected.id)}
            model={orgModels.find((m) => m.orgId === selected.id) ?? null}
            now={now}
            serverUrl={serverUrl}
            tab={search.tab ?? "projects"}
            viewerLogin={viewer?.login ?? null}
            hydrated={hydrated}
            onDialog={setDialog}
            onInvite={onInvite}
            onWithdraw={(inviteRow) =>
              withdrawOrgInvite({ data: { orgId: selected.id, inviteId: inviteRow.id } }).then(
                refresh,
              )
            }
          />
        ) : (
          <NoOrgs hydrated={hydrated} onNew={() => setDialog("org")} />
        )}
      </SidebarLayout>
      <OrgDialogs
        kind={dialog}
        org={selected}
        onInvite={onInvite}
        onClose={() => setDialog(null)}
      />
    </Page>
  );
}

/** The one open dialog, if any. New organization works with no org selected; the others need one. */
function OrgDialogs({
  kind,
  org: selected,
  onInvite,
  onClose,
}: {
  kind: DialogKind | null;
  org: OrgOverview | null;
  onInvite: (login: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const router = useRouter();
  const refresh = () => router.invalidate();
  return (
    <>
      {kind === "project" && selected && (
        <FieldDialog
          title="New project"
          description={`A project holds one app's builds, in ${selected.name}.`}
          label="Project name"
          inputLabel="New project name"
          placeholder="e.g. storefront"
          hint="Shown in lists and in the upload URL."
          emptyReason="Type a name first."
          submit="Create project"
          busyLabel="Creating…"
          onSubmit={(name) => newProject({ data: { orgId: selected.id, name } }).then(refresh)}
          onClose={onClose}
        />
      )}
      {kind === "org" && (
        <FieldDialog
          title="New organization"
          description="An organization owns projects and the people who review them."
          label="Organization name"
          inputLabel="New organization name"
          placeholder="e.g. Acme"
          hint="You become its first member."
          emptyReason="Type a name first."
          submit="Create organization"
          busyLabel="Creating…"
          onSubmit={(name) =>
            newOrg({ data: { name } }).then(async ({ id }) => {
              await router.navigate({ to: "/orgs", search: { org: id } });
              await refresh();
            })
          }
          onClose={onClose}
        />
      )}
      {kind === "invite" && selected && (
        <FieldDialog
          title="Invite to this organization"
          description={`They join ${selected.name} when they sign in with that GitHub login.`}
          label="GitHub login"
          inputLabel="Invite by GitHub login"
          placeholder="e.g. octo-dev"
          hint="Their GitHub username, not their email."
          emptyReason="Type a GitHub login first."
          submit="Invite"
          busyLabel="Inviting…"
          onSubmit={onInvite}
          onClose={onClose}
        />
      )}
    </>
  );
}

function NoOrgs({ hydrated, onNew }: { hydrated: boolean; onNew: () => void }) {
  return (
    <div
      data-testid="no-orgs"
      className="mx-auto mt-10 max-w-lg rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center"
    >
      <h1 className="mb-1.5 text-[17px] font-semibold">No organizations yet</h1>
      <p className="mb-4 text-slate-600">
        An organization owns your projects and the people who review them. Create one to add
        projects.
      </p>
      <ActionButton waiting={!hydrated} onClick={onNew}>
        + New organization
      </ActionButton>
    </div>
  );
}

function ProjectsPanel({
  org,
  now,
  serverUrl,
  hydrated,
  onDialog,
}: {
  org: OrgOverview;
  now: Date;
  serverUrl: string;
  hydrated: boolean;
  onDialog: (kind: DialogKind) => void;
}) {
  if (org.projects.length === 0) {
    return (
      <EmptyOrg
        serverUrl={serverUrl}
        onNewProject={() => onDialog("project")}
        hydrated={hydrated}
      />
    );
  }
  return (
    <>
      <WaitingStrip org={org} />
      <ProjectTable org={org} now={now} />
    </>
  );
}

function OrgPanel({
  org,
  tokens,
  model,
  now,
  serverUrl,
  tab,
  viewerLogin,
  hydrated,
  onDialog,
  onInvite,
  onWithdraw,
}: {
  org: OrgOverview;
  tokens: OrgToken[];
  model: ModelView | null;
  now: Date;
  serverUrl: string;
  tab: Tab;
  viewerLogin: string | null;
  hydrated: boolean;
  onDialog: (kind: DialogKind) => void;
  onInvite: (login: string) => Promise<unknown>;
  onWithdraw: (invite: OrgOverview["invites"][number]) => Promise<unknown>;
}) {
  return (
    <>
      <OrgHeader org={org} tab={tab} hydrated={hydrated} onDialog={onDialog} />
      {tab === "tokens" && (
        <OrgTokensPanel orgId={org.id} orgName={org.name} tokens={tokens} hydrated={hydrated} />
      )}
      {tab === "model" && (
        <ModelSettings
          key={org.id}
          scope={{ kind: "org", orgId: org.id }}
          saved={model}
          hydrated={hydrated}
        />
      )}
      {tab === "members" && (
        <MembersPanel
          org={org}
          viewerLogin={viewerLogin}
          hydrated={hydrated}
          onInvite={onInvite}
          onWithdraw={onWithdraw}
        />
      )}
      {tab === "projects" && (
        <ProjectsPanel
          org={org}
          now={now}
          serverUrl={serverUrl}
          hydrated={hydrated}
          onDialog={onDialog}
        />
      )}
    </>
  );
}
