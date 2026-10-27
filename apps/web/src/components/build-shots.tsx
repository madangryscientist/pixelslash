import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import {
  Body,
  BodyStrong,
  Button,
  Card,
  CardGrid,
  Cluster,
  type LinkRenderProps,
  ListRow,
  MetaList,
  Section,
  Stack,
  Tabs,
} from "@hackcove/ui";
import { aiFiltered } from "#/components/ai-notes";
import { ShotCard, measured } from "#/components/shot-card";
import { ReviewChip } from "#/components/ui";
import type { SnapshotView } from "#/db/review";
import { BUILD_TABS, type BuildTab } from "#/lib/build-tabs";
import { type ShotLabel, shotLabeller } from "#/lib/shot-label";
import { GROUP_LABEL, type SnapshotGroup, groupOf } from "#/lib/snapshot-groups";

export function BuildTabs({
  projectId,
  buildId,
  active,
  counts,
}: {
  projectId: string;
  buildId: string;
  active: BuildTab;
  counts: Record<BuildTab, number>;
}) {
  return (
    <Tabs
      variant="pill"
      label="Shots in this build"
      value={active}
      items={BUILD_TABS.map((tab) => ({
        value: tab.id,
        label: tab.label,
        count: counts[tab.id],
        render: (props: LinkRenderProps) => (
          <Link
            to="/projects/$projectId/builds/$buildId"
            params={{ projectId, buildId }}
            search={{ tab: tab.id }}
            replace
            resetScroll={false}
            data-testid={`tab-${tab.id}`}
            {...props}
          />
        ),
      }))}
    />
  );
}

function ShotRows({
  projectId,
  buildId,
  rows,
  baseline,
}: {
  projectId: string;
  buildId: string;
  rows: SnapshotView[];
  baseline: boolean;
}) {
  return (
    <Card flush>
      <ul>
        {rows.map((shot, index) => (
          <li key={shot.id} data-testid="snapshot-row">
            <ListRow
              divided={index > 0}
              trailing={
                !baseline &&
                shot.reviewState !== "pending" && (
                  <ReviewChip state={shot.reviewState} by={shot.reviewedBy} />
                )
              }
              render={(props) => (
                <Link
                  to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                  params={{ projectId, buildId, snapshotId: shot.id }}
                  {...props}
                />
              )}
            >
              <Cluster gap="sm" wrap>
                <BodyStrong>{shot.name}</BodyStrong>
                <MetaList>
                  {shot.platform}
                  {shot.browser}
                  {shot.viewport}
                  {shot.theme}
                </MetaList>
                <Body tone="muted">{measured(shot, baseline)}</Body>
              </Cluster>
            </ListRow>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function GroupSection({
  group,
  count,
  heading,
  children,
}: {
  group: SnapshotGroup;
  count: number;
  heading: boolean;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <Section
      data-testid={`group-${group}`}
      gap="xs"
      title={
        heading && (
          <>
            {GROUP_LABEL[group]} <Body tone="muted">({count})</Body>
          </>
        )
      }
    >
      {children}
    </Section>
  );
}

/** Unchanged shots are never the default view: the tab opens on a "show" row, not 138 lines. */
function UnchangedFold({
  projectId,
  buildId,
  rows,
  baseline,
}: {
  projectId: string;
  buildId: string;
  rows: SnapshotView[];
  baseline: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <GroupSection group="unchanged" count={rows.length} heading={false}>
      {shown ? (
        <ShotRows projectId={projectId} buildId={buildId} rows={rows} baseline={baseline} />
      ) : (
        <Button variant="dashed" data-testid="unchanged-show" onClick={() => setShown(true)}>
          {rows.length} unchanged shot{rows.length === 1 ? "" : "s"} are folded away. Show
        </Button>
      )}
    </GroupSection>
  );
}

export function TabBody({
  projectId,
  buildId,
  tab,
  snapshots,
  thumbs,
  baseline,
}: {
  projectId: string;
  buildId: string;
  tab: BuildTab;
  snapshots: SnapshotView[];
  thumbs: Record<string, string>;
  baseline: boolean;
}) {
  const label = useMemo(() => shotLabeller(snapshots.map((shot) => shot.name)), [snapshots]);
  const definition = BUILD_TABS.find((candidate) => candidate.id === tab);
  const groups = definition?.groups ?? [];
  const inGroup = (group: SnapshotGroup) => snapshots.filter((shot) => groupOf(shot) === group);

  if (groups.every((group) => inGroup(group).length === 0)) {
    return (
      <Body as="p" tone="muted" data-testid="tab-empty">
        Nothing in {definition?.label ?? "this tab"}.
      </Body>
    );
  }
  if (tab === "changed" || tab === "new") {
    return (
      <CardGroups
        projectId={projectId}
        buildId={buildId}
        group={tab}
        rows={inGroup(tab)}
        label={label}
        thumbs={thumbs}
        baseline={baseline}
      />
    );
  }
  if (tab === "unchanged") {
    return (
      <UnchangedFold
        projectId={projectId}
        buildId={buildId}
        rows={inGroup("unchanged")}
        baseline={baseline}
      />
    );
  }
  return (
    <Stack gap="lg">
      {groups.map((group) => (
        <GroupSection key={group} group={group} count={inGroup(group).length} heading>
          <ShotRows
            projectId={projectId}
            buildId={buildId}
            rows={inGroup(group)}
            baseline={baseline}
          />
        </GroupSection>
      ))}
    </Stack>
  );
}

/** A changed or new tab's cards; those the project's model auto-passed as noise below, in their own group (ob 1473). */
function CardGroups({
  projectId,
  buildId,
  group,
  rows,
  label,
  thumbs,
  baseline,
}: {
  projectId: string;
  buildId: string;
  group: "changed" | "new";
  rows: SnapshotView[];
  label: (name: string) => ShotLabel;
  thumbs: Record<string, string>;
  baseline: boolean;
}) {
  const cards = (shots: SnapshotView[]) => (
    <CardGrid as="ul" columns="auto" minWidth="md">
      {shots.map((shot) => (
        <ShotCard
          key={shot.id}
          projectId={projectId}
          buildId={buildId}
          shot={shot}
          label={label(shot.name)}
          src={thumbs[shot.id]}
          baseline={baseline}
        />
      ))}
    </CardGrid>
  );
  const filtered = rows.filter(aiFiltered);
  return (
    <Stack gap="lg">
      <GroupSection group={group} count={rows.length - filtered.length} heading={false}>
        {cards(rows.filter((shot) => !aiFiltered(shot)))}
      </GroupSection>
      {filtered.length > 0 && (
        <Section
          data-testid="group-ai-filtered"
          gap="xs"
          title={
            <>
              AI-filtered <Body tone="muted">({filtered.length})</Body>
            </>
          }
        >
          <Body as="p" tone="muted">
            Accepted without a person: the project&apos;s model labelled every changed region noise.
            Open one to reject it.
          </Body>
          {cards(filtered)}
        </Section>
      )}
    </Stack>
  );
}
