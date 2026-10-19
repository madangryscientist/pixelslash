import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
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
        <p className="mb-6 text-neutral-600">No organizations yet. Create one to add projects.</p>
      )}
      <ul className="space-y-6">
        {orgs.map((org) => (
          <li key={org.id} className="rounded-lg border border-neutral-200 bg-white p-5">
            <h2 className="text-lg font-semibold">{org.name}</h2>
            <ul className="my-3 divide-y divide-neutral-100">
              {org.projects.map((p) => (
                <li key={p.id} className="flex justify-between py-2">
                  <span>{p.name}</span>
                  <Link
                    to="/projects/$projectId/settings"
                    params={{ projectId: p.id }}
                    className="text-sm text-blue-700 hover:underline"
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
