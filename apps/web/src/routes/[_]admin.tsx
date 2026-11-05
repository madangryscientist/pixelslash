import { createFileRoute } from "@tanstack/react-router";
import { Breadcrumbs, PageHeader, Stack } from "@hackcove/ui-react";
import { Page } from "#/components/ui";
import { OperatorHealthView } from "#/components/operator-health";
import { getOperatorHealth } from "#/server/admin";

/**
 * The operator's health page (PS-330): read-only, a 404 for anyone not on `PIXELSLASH_ADMIN_LOGINS`.
 * A report of several sections, not an index of records, so it is a `PageHeader` over a `Stack`
 * rather than `ListLayout`.
 */
export const Route = createFileRoute("/_admin")({
  loader: () => getOperatorHealth(),
  component: OperatorHealthPage,
});

function OperatorHealthPage() {
  const health = Route.useLoaderData();
  return (
    <Page>
      <PageHeader
        breadcrumbs={<Breadcrumbs crumbs={["Operator health"]} />}
        title="Operator health"
      />
      <Stack>
        <OperatorHealthView health={health} />
      </Stack>
    </Page>
  );
}
