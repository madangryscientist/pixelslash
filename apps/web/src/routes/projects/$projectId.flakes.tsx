import {
  Body,
  BodyStrong,
  Breadcrumbs,
  Button,
  ButtonGroup,
  Caption,
  Card,
  Cluster,
  ClusterGrow,
  Input,
  ListLayout,
  Pill,
  Stack,
  TextLink,
} from "@hackcove/ui";
import { Link, createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { orgCrumb, projectCrumb } from "#/components/crumbs";
import { useFlagWrite } from "#/components/detection-flag";
import { FlakeHistory, FlakeRuns, FlakyPolicyControl, flakeAnchor } from "#/components/flake";
import { Page, useHydrated } from "#/components/ui";
import { formatRelative } from "#/lib/format";
import { type FlakeView, getFlakesPage, saveFlakeStatus } from "#/server/flakes";

export const Route = createFileRoute("/projects/$projectId/flakes")({
  loader: ({ params }) => getFlakesPage({ data: { projectId: params.projectId } }),
  component: FlakesPage,
});

/** The flake's variant, as the build page names one: what is not the default reads as a chip. */
const variantOf = (flake: FlakeView) =>
  [flake.platform, flake.browser, flake.viewport, flake.theme].join(" · ");

/** Resolve with an optional note, or reopen a resolved flake. */
function StatusControl({ projectId, flake }: { projectId: string; flake: FlakeView }) {
  const hydrated = useHydrated();
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const { busy, error, run } = useFlagWrite(() => setResolving(false));
  const ids = { projectId, flakeId: flake.id };
  const resolve = (event: FormEvent) => {
    event.preventDefault();
    run(() => saveFlakeStatus({ data: { ...ids, open: false, note } }));
  };
  if (flake.status === "resolved") {
    return (
      <Stack gap="xs">
        <Button
          variant="outline"
          busy={busy}
          busyLabel="Reopening…"
          disabledReason={hydrated ? undefined : "Loading"}
          onClick={() => run(() => saveFlakeStatus({ data: { ...ids, open: true, note: null } }))}
          size="sm"
        >
          Reopen
        </Button>
        {error && (
          <Body as="p" role="alert" tone="danger">
            {error}
          </Body>
        )}
      </Stack>
    );
  }
  if (!resolving) {
    return (
      <Button variant="outline" disabled={!hydrated} onClick={() => setResolving(true)} size="sm">
        Resolve
      </Button>
    );
  }
  return (
    <Stack as="form" gap="xs" onSubmit={resolve} aria-label="Resolve flake">
      <Input
        aria-label="Resolution note (optional)"
        placeholder="What fixed it (optional)"
        value={note}
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && (
        <Body as="p" role="alert" tone="danger">
          {error}
        </Body>
      )}
      <ButtonGroup>
        <Button type="submit" busy={busy} busyLabel="Resolving…" size="sm">
          Resolve
        </Button>
        <Button type="button" variant="ghost" onClick={() => setResolving(false)} size="sm">
          Cancel
        </Button>
      </ButtonGroup>
    </Stack>
  );
}

function FlakeItem({ projectId, flake, now }: { projectId: string; flake: FlakeView; now: Date }) {
  const latest = flake.evidence.at(-1);
  // The policy the latest detection was captured under; a hand mark sent none, so review.
  const policy = latest?.policy ?? "review";
  return (
    <li id={flakeAnchor(flake.id)} className="scroll-mt-6">
      <Card as="article" data-testid="flake" data-status={flake.status}>
        <Stack gap="sm">
          <Cluster gap="sm" align="start" justify="between" wrap>
            <ClusterGrow>
              <Cluster gap="xs">
                <Pill tone={flake.status === "open" ? "amber" : "slate"}>{flake.status}</Pill>
                <BodyStrong truncate data-testid="flake-name">
                  {flake.name}
                </BodyStrong>
              </Cluster>
              <Caption as="p">
                {variantOf(flake)} · {flake.evidence.length} detection
                {flake.evidence.length === 1 ? "" : "s"} · updated{" "}
                {formatRelative(flake.updatedAt, now)}
              </Caption>
            </ClusterGrow>
            <StatusControl projectId={projectId} flake={flake} />
          </Cluster>
          <FlakeHistory flake={flake} />
          {latest && (
            <Stack gap="xs">
              <FlakeRuns evidence={latest} />
              <TextLink
                render={(props) => (
                  <Link
                    to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                    params={{ projectId, buildId: latest.buildId, snapshotId: latest.snapshotId }}
                    {...props}
                  />
                )}
              >
                See the shot
              </TextLink>
            </Stack>
          )}
          <details>
            <summary className="cursor-pointer">
              <Body tone="muted">Policy: {policy}. Change it in config</Body>
            </summary>
            <div className="mt-2">
              <FlakyPolicyControl policy={policy} />
            </div>
          </details>
        </Stack>
      </Card>
    </li>
  );
}

function FlakesPage() {
  const { project, org, flakes, now } = Route.useLoaderData();
  const open = flakes.filter((f) => f.status === "open").length;
  return (
    <Page>
      <ListLayout
        breadcrumbs={<Breadcrumbs crumbs={[orgCrumb(org), projectCrumb(project), "Flakes"]} />}
        title={`${project.name} · flakes`}
        subtitle={
          flakes.length === 0
            ? "No flakes. A shot is flaky when the CLI captured it again and the captures disagreed, or when a reviewer marked it."
            : `${open} open, ${flakes.length - open} resolved. Open flakes first.`
        }
      >
        <Stack as="ul" gap="sm">
          {flakes.map((flake) => (
            <FlakeItem key={flake.id} projectId={project.id} flake={flake} now={now} />
          ))}
        </Stack>
      </ListLayout>
    </Page>
  );
}
