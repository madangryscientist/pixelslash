import { Link, useRouter } from "@tanstack/react-router";
import {
  Card,
  Code,
  SectionHeading,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
  TextLink,
} from "@hackcove/ui-react";
import { ToReview } from "#/components/build-mix";
import { StatusBadge, InlineForm } from "#/components/ui";
import type { SubprojectRow } from "#/db/subprojects";
import { addSubproject } from "#/server/subprojects";

/** A project page's subprojects, above its own builds: each a link, with its newest build. */
export function SubprojectList({
  subprojects,
  defaultBranch,
}: {
  subprojects: SubprojectRow[];
  defaultBranch: string;
}) {
  if (subprojects.length === 0) return null;
  return (
    <Table caption="Subprojects" data-testid="subprojects">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Subproject</TableHeaderCell>
          <TableHeaderCell>Latest build</TableHeaderCell>
          <TableHeaderCell>To review</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {subprojects.map((sub) => (
          <TableRow key={sub.id} data-testid="subproject-row">
            <TableCell>
              <TextLink
                stretch
                render={(props) => (
                  <Link to="/projects/$projectId" params={{ projectId: sub.id }} {...props} />
                )}
              >
                {sub.name}
              </TextLink>
            </TableCell>
            <TableCell>
              {sub.latest ? (
                <StatusBadge status={sub.latest.status} />
              ) : (
                <Text tone="muted">no builds</Text>
              )}
            </TableCell>
            <TableCell>
              <ToReview build={sub.latest} defaultBranch={defaultBranch} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** A subproject's settings: what it takes from its parent, and where to change it. */
export function InheritedSettings({ parent }: { parent: { id: string; name: string } }) {
  return (
    <Card data-testid="inherited-settings">
      <Stack gap="xs">
        <SectionHeading>Set on {parent.name}</SectionHeading>
        <Text as="p">
          This is a subproject of {parent.name}. Its GitHub repo and PR comment, default branch, AI
          model and CI tokens are {parent.name}&apos;s: its CI token uploads here with{" "}
          <Code>--subproject</Code>.{" "}
          <TextLink
            render={(props) => (
              <Link
                to="/projects/$projectId/settings"
                params={{ projectId: parent.id }}
                {...props}
              />
            )}
          >
            Open {parent.name}&apos;s settings
          </TextLink>
        </Text>
      </Stack>
    </Card>
  );
}

/** A top-level project's "Add a subproject" form. */
export function AddSubproject({ projectId }: { projectId: string }) {
  const router = useRouter();
  return (
    <Card data-testid="add-subproject">
      <Stack>
        <Stack gap="xs">
          <SectionHeading>Subprojects</SectionHeading>
          <Text as="p">
            A subproject keeps one kind of shot apart (end-to-end tests, stories) with its own
            builds, baselines and review. It uses this project&apos;s repo, default branch, model
            and CI tokens.
          </Text>
        </Stack>
        <InlineForm
          label="Subproject name, e.g. e2e"
          button="Add a subproject"
          busyLabel="Adding…"
          emptyReason="Name the subproject first."
          onSubmit={async (name) => {
            const { id } = await addSubproject({ data: { projectId, name } });
            await router.navigate({ to: "/projects/$projectId", params: { projectId: id } });
          }}
        />
      </Stack>
    </Card>
  );
}
