import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { type LinkRenderProps, Tabs } from "@hackcove/ui";
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
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
      {rows.map((shot) => (
        <li key={shot.id} data-testid="snapshot-row">
          <Link
            to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
            params={{ projectId, buildId, snapshotId: shot.id }}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-slate-50"
          >
            <span className="font-medium">{shot.name}</span>
            <span className="text-sm text-slate-500">
              {shot.platform} · {shot.browser} · {shot.viewport} · {shot.theme}
            </span>
            <span className="text-sm text-slate-600">{measured(shot, baseline)}</span>
            {!baseline && shot.reviewState !== "pending" && (
              <span className="ml-auto">
                <ReviewChip state={shot.reviewState} by={shot.reviewedBy} />
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
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
    <section data-testid={`group-${group}`} className="mb-8">
      {heading && (
        <h2 className="mb-2 text-lg font-semibold">
          {GROUP_LABEL[group]} <span className="text-slate-500">({count})</span>
        </h2>
      )}
      {children}
    </section>
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
        <button
          type="button"
          data-testid="unchanged-show"
          onClick={() => setShown(true)}
          className="w-full rounded-lg border border-dashed border-slate-300 px-4 py-3 text-left text-sm text-slate-600 hover:bg-slate-50"
        >
          {rows.length} unchanged shot{rows.length === 1 ? "" : "s"} are folded away. Show
        </button>
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
      <p className="text-slate-600" data-testid="tab-empty">
        Nothing in {definition?.label ?? "this tab"}.
      </p>
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
    <>
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
    </>
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
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-4">
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
    </ul>
  );
  const filtered = rows.filter(aiFiltered);
  return (
    <>
      <GroupSection group={group} count={rows.length - filtered.length} heading={false}>
        {cards(rows.filter((shot) => !aiFiltered(shot)))}
      </GroupSection>
      {filtered.length > 0 && (
        <section data-testid="group-ai-filtered" className="mb-8">
          <h2 className="mb-1 text-lg font-semibold">
            AI-filtered <span className="text-slate-500">({filtered.length})</span>
          </h2>
          <p className="mb-3 text-sm text-slate-600">
            Accepted without a person: the project&apos;s model labelled every changed region noise.
            Open one to reject it.
          </p>
          {cards(filtered)}
        </section>
      )}
    </>
  );
}
