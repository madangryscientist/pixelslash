import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { navTabClass } from "@hackcove/ui";
import { ShotCard, measured } from "#/components/shot-card";
import { ReviewChip } from "#/components/ui";
import type { SnapshotView } from "#/db/review";
import { BUILD_TABS, type BuildTab } from "#/lib/build-tabs";
import { shotLabeller } from "#/lib/shot-label";
import { GROUP_LABEL, type SnapshotGroup, groupOf } from "#/lib/snapshot-groups";

export function Tabs({
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
    <nav aria-label="Shots in this build" className="mb-6 flex flex-wrap gap-2">
      {BUILD_TABS.map((tab) => (
        <Link
          key={tab.id}
          to="/projects/$projectId/builds/$buildId"
          params={{ projectId, buildId }}
          search={{ tab: tab.id }}
          replace
          resetScroll={false}
          data-testid={`tab-${tab.id}`}
          aria-current={tab.id === active ? "page" : undefined}
          className={navTabClass(tab.id === active)}
        >
          {tab.label} <span data-testid={`tab-count-${tab.id}`}>{counts[tab.id]}</span>
        </Link>
      ))}
    </nav>
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
    const rows = inGroup(tab);
    return (
      <GroupSection group={tab} count={rows.length} heading={false}>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-4">
          {rows.map((shot) => (
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
      </GroupSection>
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
