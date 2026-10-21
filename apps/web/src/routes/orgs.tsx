import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { Body, Card, SectionHeading } from "@hackcove/ui";
import { InlineForm, Page } from "#/components/ui";
import { getOrgs, invite, newOrg, newProject } from "#/server/fns";

export const Route = createFileRoute("/orgs")({
  loader: () => getOrgs(),
  component: Orgs,
});

function Orgs() {
  const orgs = Route.useLoaderData();
  const router = useRouter();
  const refresh = () => router.invalidate();
  return (
    <Page title="Organizations">
      {orgs.length === 0 && (
        <Body as="p" className="mb-6">
          No organizations yet. Create one to add projects.
        </Body>
      )}
      <ul className="space-y-6">
        {orgs.map((org) => (
          <li key={org.id}>
            <Card>
              <SectionHeading>{org.name}</SectionHeading>
              <ul className="my-3 divide-y divide-slate-100">
                {org.projects.map((p) => (
                  <li key={p.id} className="flex justify-between py-2">
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: p.id }}
                      className="font-medium text-violet-600 hover:underline"
                    >
                      {p.name}
                    </Link>
                    <Link
                      to="/projects/$projectId/settings"
                      params={{ projectId: p.id }}
                      className="text-sm text-slate-500 hover:text-slate-700 hover:underline"
                    >
                      Settings
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="space-y-2">
                <InlineForm
                  label="New project name"
                  button="Create project"
                  onSubmit={(name) => newProject({ data: { orgId: org.id, name } }).then(refresh)}
                />
                <InlineForm
                  label="Invite by GitHub login"
                  button="Invite"
                  onSubmit={(login) => invite({ data: { orgId: org.id, login } }).then(refresh)}
                />
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <section className="mt-8">
        <InlineForm
          label="New organization name"
          button="Create organization"
          onSubmit={(name) => newOrg({ data: { name } }).then(refresh)}
        />
      </section>
    </Page>
  );
}
