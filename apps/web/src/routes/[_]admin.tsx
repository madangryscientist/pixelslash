import { createFileRoute } from "@tanstack/react-router";
import { Breadcrumbs, ListLayout } from "@hackcove/ui-react";
import { Page } from "#/components/ui";
import { OperatorHealthView } from "#/components/operator-health";
import { getOperatorHealth } from "#/server/admin";

/** The operator's health page (PS-330): read-only, a 404 for anyone not on `PIXELSLASH_ADMIN_LOGINS`. */
export const Route = createFileRoute("/_admin")({
  loader: () => getOperatorHealth(),
  component: OperatorHealthPage,
});

function OperatorHealthPage() {
  const health = Route.useLoaderData();
  return (
    <Page>
      <ListLayout
        breadcrumbs={<Breadcrumbs crumbs={["Operator health"]} />}
        title="Operator health"
      >
        <OperatorHealthView health={health} />
      </ListLayout>
    </Page>
  );
}
