import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Button, type LinkRenderProps, Tabs } from "@hackcove/ui";
import { ShotThumb } from "#/components/shot-card";
import { ReviewChip, useHydrated } from "#/components/ui";
import {
  MAIN_GROUPS,
  type BranchShot,
  type ChangeLine,
  type MainGroup,
  type MainSummary,
  decisionText,
  measuredFacts,
} from "#/lib/branch-review";

export type BranchMode = "main" | "since";

/** The verdict reads the review states and nothing else; it is not an approval of its own. */
function verdictText(summary: MainSummary, status: string): string {
  if (summary.ready) return "Ready to merge";
  const open = [
    summary.waiting > 0 ? `${summary.waiting} waiting` : null,
    summary.rejected > 0 ? `${summary.rejected} rejected` : null,
    summary.unmeasured > 0 ? `${summary.unmeasured} not measured against main` : null,
  ].filter((part) => part !== null);
  if (open.length === 0) return `Not ready to merge: the newest build is ${status}`;
  return `Not ready to merge: ${open.join(", ")}`;
}

export function MainSummaryBox({ summary, status }: { summary: MainSummary; status: string }) {
  const counts: [string, number, string][] = [
    ["changed", summary.changed, "changed against main"],
    ["accepted", summary.accepted, "accepted"],
    ["waiting", summary.waiting, "waiting"],
    ["rejected", summary.rejected, "rejected"],
  ];
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4"
      data-testid="branch-summary"
    >
      <div className="flex flex-wrap gap-6">
        {counts.map(([id, n, label]) => (
          <span key={id} className="text-sm text-slate-600" data-testid={`summary-${id}`}>
            <b className="mr-1 text-xl text-slate-900">{n}</b>
            {label}
          </span>
        ))}
      </div>
      <span
        data-testid="merge-verdict"
        className={`rounded-md px-3 py-1.5 text-sm font-medium ${
          summary.ready ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"
        }`}
      >
        {verdictText(summary, status)}
      </span>
    </div>
  );
}

export function ModeTabs({
  projectId,
  branch,
  active,
}: {
  projectId: string;
  branch: string;
  active: BranchMode;
}) {
  const modes: { id: BranchMode; label: string }[] = [
    { id: "main", label: "Against main" },
    { id: "since", label: "Since last build" },
  ];
  return (
    <Tabs
      variant="pill"
      label="Read the branch"
      value={active}
      items={modes.map((mode) => ({
        value: mode.id,
        label: mode.label,
        render: (props: LinkRenderProps) => (
          <Link
            to="/projects/$projectId/branches/$branch"
            params={{ projectId, branch }}
            search={mode.id === "main" ? {} : { mode: mode.id }}
            replace
            resetScroll={false}
            data-testid={`mode-${mode.id}`}
            {...props}
          />
        ),
      }))}
    />
  );
}

/**
 * One line per changed shot, in the order the mode groups them. A judge's note comes first when
 * there is one; the measured facts always follow, so a note never stands in for a measurement.
 */
export function ChangeSummary({
  title,
  detail,
  lines,
  empty,
}: {
  title: string;
  detail: string;
  lines: ChangeLine[];
  empty: string;
}) {
  const described = lines.some((line) => line.note !== null);
  return (
    <div
      className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-4"
      data-testid="change-summary"
    >
      <h3 className="mb-2 font-semibold">
        {title} <small className="font-normal text-slate-500">{detail}</small>
      </h3>
      {lines.length === 0 ? (
        <p className="text-sm text-slate-600">{empty}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {lines.map((line) => (
            <li key={line.id} data-testid="change-line">
              <b>{line.name}</b> <span className="text-slate-500">{line.variant}</span>:{" "}
              {line.note && <span data-testid="change-note">{line.note}. </span>}
              {line.facts}. <span className="text-slate-600">{line.state}</span>
            </li>
          ))}
        </ul>
      )}
      {described && (
        <p className="mt-2 text-xs text-slate-500" data-testid="change-note-source">
          Described by the judge (local model); sizes and pixel counts are measured.
        </p>
      )}
    </div>
  );
}

const MAIN_HEADING: Record<MainGroup, string> = {
  rejected: "Rejected",
  waiting: "Waiting",
  accepted: "Accepted",
  same: "Same as main",
  unmeasured: "Not measured against main",
};

/** What was measured against main, in the row's words. */
function againstMainText(shot: BranchShot): string {
  if (shot.mainGroup === "unmeasured") return "not measured against main";
  if (shot.mainDiffStatus === "new") return "new: no accepted shot on main at the merge-base";
  return `${measuredFacts(shot.mainDiffStatus, shot.mainDiffResult)} against main`;
}

function MainRow({
  projectId,
  buildId,
  shot,
  src,
  reviewable,
  onReview,
}: {
  projectId: string;
  buildId: string;
  shot: BranchShot;
  src: string | undefined;
  reviewable: boolean;
  onReview: (snapshotId: string, state: "accepted" | "rejected") => Promise<void>;
}) {
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const review = (state: "accepted" | "rejected") => {
    setBusy(true);
    void onReview(shot.id, state).finally(() => setBusy(false));
  };
  const shown = shot.mainDiffStatus === "changed" || shot.mainDiffStatus === "new";
  // The thumbnail draws the boxes measured against main, over the same branch shot.
  const thumb = { ...shot, diffStatus: shot.mainDiffStatus, diffResult: shot.mainDiffResult };
  const disabled = !hydrated || busy || !reviewable;
  return (
    <li
      data-testid="main-row"
      data-group={shot.mainGroup}
      className="grid grid-cols-[8rem_1fr_auto] items-center gap-4 px-4 py-3"
    >
      <div>{shown && <ShotThumb shot={thumb} src={src} />}</div>
      <div className="min-w-0">
        <Link
          to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
          params={{ projectId, buildId, snapshotId: shot.id }}
          className="font-medium hover:underline"
          data-testid="main-row-name"
        >
          {shot.name}
        </Link>{" "}
        <span className="text-sm text-slate-500">
          {shot.platform} · {shot.browser} · {shot.viewport} · {shot.theme}
        </span>
        <p className="text-sm text-slate-700" data-testid="main-row-what">
          {againstMainText(shot)}
        </p>
        {shot.decision && (
          <p className="text-sm text-slate-500" data-testid="main-row-who">
            {decisionText(shot)}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {shot.mainGroup === "waiting" ? (
          <>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => review("rejected")}
              className="px-3 py-1.5"
              data-testid="main-reject"
            >
              Reject
            </Button>
            <Button
              disabled={disabled}
              onClick={() => review("accepted")}
              className="px-3 py-1.5"
              data-testid="main-accept"
            >
              Accept
            </Button>
          </>
        ) : (
          shot.decision && <ReviewChip state={shot.decision.state} />
        )}
      </div>
    </li>
  );
}

function Fold({ count, noun, children }: { count: number; noun: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  if (shown) return children;
  return (
    <button
      type="button"
      data-testid="main-fold-show"
      onClick={() => setShown(true)}
      className="w-full rounded-lg border border-dashed border-slate-300 px-4 py-3 text-left text-sm text-slate-600 hover:bg-slate-50"
    >
      {count} shot{count === 1 ? "" : "s"} folded away: {noun}. Show
    </button>
  );
}

const FOLDED: Partial<Record<MainGroup, string>> = {
  same: "identical to main's accepted shots",
  unmeasured: "not measured against main, so not counted",
};

/** The against-main groups: what stops a merge first; shots that match main are folded away. */
export function MainGroups({
  projectId,
  buildId,
  shots,
  thumbs,
  reviewable,
  onReview,
}: {
  projectId: string;
  buildId: string;
  shots: BranchShot[];
  thumbs: Record<string, string>;
  reviewable: boolean;
  onReview: (snapshotId: string, state: "accepted" | "rejected") => Promise<void>;
}) {
  return (
    <>
      {MAIN_GROUPS.map((group) => {
        const rows = shots.filter((shot) => shot.mainGroup === group);
        if (rows.length === 0) return null;
        const list = (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {rows.map((shot) => (
              <MainRow
                key={shot.id}
                projectId={projectId}
                buildId={buildId}
                shot={shot}
                src={thumbs[shot.id]}
                reviewable={reviewable}
                onReview={onReview}
              />
            ))}
          </ul>
        );
        const folded = FOLDED[group];
        return (
          <section key={group} className="mb-8" data-testid={`main-group-${group}`}>
            <h2 className="mb-2 text-lg font-semibold">
              {MAIN_HEADING[group]} <span className="text-slate-500">({rows.length})</span>
            </h2>
            {folded ? (
              <Fold count={rows.length} noun={folded}>
                {list}
              </Fold>
            ) : (
              list
            )}
          </section>
        );
      })}
    </>
  );
}
