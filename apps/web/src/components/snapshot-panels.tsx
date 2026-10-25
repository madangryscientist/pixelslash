import { type ReactNode } from "react";
import { Button, Container, Dialog, Kbd, KeyValue, KeyValueList, Pill } from "@hackcove/ui";
import { ReviewChip, StatusBadge, useHydrated } from "#/components/ui";
import type { BuildView, SnapshotView } from "#/db/review";
import { formatDateTime } from "#/lib/format";
import { type ShotLabel, variantChips } from "#/lib/shot-label";

/** Every key the page answers to, for the `?` list. */
const SHORTCUTS: [string, string][] = [
  ["j", "Next shot"],
  ["k", "Previous shot"],
  ["a", "Accept this shot"],
  ["r", "Reject this shot"],
  ["?", "Show these shortcuts"],
  ["Esc", "Close this list"],
];

const barButton =
  "inline-flex items-center rounded-md px-2.5 py-1 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 disabled:opacity-50";

type Review = { index: number | null; total: number };

function reviewText(review: Review): string {
  if (review.index !== null) return `${review.index} / ${review.total} with a change`;
  if (review.total === 0) return "nothing to review";
  return `not to review · ${review.total} with a change`;
}

/**
 * The readable name with the raw key as its tooltip, the name's variants, and where the build and
 * this shot's decision stand.
 */
function ShotTitle({
  build,
  snapshot,
  label,
}: {
  build: BuildView["build"];
  snapshot: SnapshotView;
  label: ShotLabel;
}) {
  const title = label.component ? `${label.component} · ${label.story}` : label.story;
  return (
    <>
      <h1 className="min-w-0 truncate text-base font-semibold" title={snapshot.name}>
        {title}
      </h1>
      {variantChips(label).map((chip) => (
        <Pill key={chip} tone="slate">
          {chip}
        </Pill>
      ))}
      <StatusBadge status={build.status} />
      <ReviewChip state={snapshot.reviewState} by={snapshot.reviewedBy} />
      {snapshot.reviewedAt && (
        <span className="text-sm text-slate-500">{formatDateTime(snapshot.reviewedAt)}</span>
      )}
    </>
  );
}

type BarActions = {
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onAccept: () => void;
  onReject: () => void;
  /** Open or close the flag form; `flagOpen` says which. Flagging is not a review decision. */
  onFlag: () => void;
  flagOpen: boolean;
  onHelp: () => void;
};

const outline = `${barButton} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;

/** Walk, decide, and the key list: each button shows the key that does the same. */
function Actions({
  actions,
  canDecide,
  why,
}: {
  actions: BarActions;
  canDecide: boolean;
  why: string | undefined;
}) {
  const hydrated = useHydrated();
  const { onPrevious, onNext } = actions;
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label="Previous shot"
        aria-keyshortcuts="k"
        disabled={!hydrated || !onPrevious}
        onClick={() => onPrevious?.()}
        className={outline}
      >
        ‹ <Kbd aria-hidden="true">k</Kbd>
      </button>
      <button
        type="button"
        aria-label="Next shot"
        aria-keyshortcuts="j"
        disabled={!hydrated || !onNext}
        onClick={() => onNext?.()}
        className={outline}
      >
        › <Kbd aria-hidden="true">j</Kbd>
      </button>
      <button
        type="button"
        aria-expanded={actions.flagOpen}
        disabled={!hydrated}
        title="Missed change or false positive: tell PixelSlash the diff got this shot wrong"
        onClick={actions.onFlag}
        className={`${outline} ${actions.flagOpen ? "border-violet-500! text-violet-700!" : ""}`}
      >
        Flag detection
      </button>
      <button
        type="button"
        aria-keyshortcuts="r"
        disabled={!hydrated || !canDecide}
        title={why}
        onClick={actions.onReject}
        className={`${barButton} border border-red-300 bg-white text-red-700 hover:bg-red-50`}
      >
        Reject <Kbd aria-hidden="true">r</Kbd>
      </button>
      <button
        type="button"
        aria-keyshortcuts="a"
        disabled={!hydrated || !canDecide}
        title={why}
        onClick={actions.onAccept}
        className={`${barButton} border border-transparent bg-emerald-700 text-white hover:bg-emerald-800`}
      >
        Accept <Kbd aria-hidden="true">a</Kbd>
      </button>
      <button
        type="button"
        data-testid="keyboard-hint"
        aria-label="Keyboard shortcuts"
        aria-keyshortcuts="?"
        disabled={!hydrated}
        onClick={actions.onHelp}
        className={`${barButton} text-slate-500 hover:text-slate-700`}
      >
        ?
      </button>
    </div>
  );
}

/**
 * The bar that stays on screen: what this shot is, where it sits in the review, and the decision.
 * The review position counts the changed shots; the build position, the whole j/k walk.
 */
export function ViewerBar({
  build,
  snapshot,
  label,
  position,
  total,
  review,
  reviewable,
  busy,
  actions,
  breadcrumbs,
}: {
  breadcrumbs: ReactNode;
  build: BuildView["build"];
  snapshot: SnapshotView;
  label: ShotLabel;
  position: number;
  total: number;
  review: Review;
  reviewable: boolean;
  busy: boolean;
  actions: BarActions;
}) {
  const why = reviewable ? undefined : `This build is ${build.status}; a new build is needed.`;
  return (
    <div className="sticky top-14 z-10 border-b border-slate-200 bg-white">
      <Container>
        {breadcrumbs}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ShotTitle build={build} snapshot={snapshot} label={label} />
          <span className="flex-1" />
          <span data-testid="review-position" className="text-sm text-slate-600 tabular-nums">
            {reviewText(review)}
          </span>
          <span data-testid="position" className="text-sm text-slate-500 tabular-nums">
            {position} of {total}
          </span>
          <Actions actions={actions} canDecide={reviewable && !busy} why={why} />
        </div>
      </Container>
    </div>
  );
}

/** The `?` list, on hackcove's `Dialog`: the page goes inert, Esc and a click on the scrim close it. */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Keyboard shortcuts"
      size="sm"
      onClose={onClose}
      footer={
        <Button variant="outline" autoFocus onClick={onClose}>
          Close
        </Button>
      }
    >
      <KeyValueList>
        {SHORTCUTS.map(([key, what]) => (
          <KeyValue key={key} label={what}>
            <Kbd>{key}</Kbd>
          </KeyValue>
        ))}
      </KeyValueList>
    </Dialog>
  );
}
