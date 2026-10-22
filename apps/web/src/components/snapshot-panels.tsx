import { Pill } from "@hackcove/ui";
import { type ReactNode, useEffect, useRef } from "react";
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

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      aria-hidden="true"
      className="ml-1.5 rounded border border-current/30 px-1 font-mono text-[10px] leading-4 opacity-75"
    >
      {children}
    </kbd>
  );
}

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
        ‹<Kbd>k</Kbd>
      </button>
      <button
        type="button"
        aria-label="Next shot"
        aria-keyshortcuts="j"
        disabled={!hydrated || !onNext}
        onClick={() => onNext?.()}
        className={outline}
      >
        ›<Kbd>j</Kbd>
      </button>
      <button
        type="button"
        aria-keyshortcuts="r"
        disabled={!hydrated || !canDecide}
        title={why}
        onClick={actions.onReject}
        className={`${barButton} border border-red-300 bg-white text-red-700 hover:bg-red-50`}
      >
        Reject<Kbd>r</Kbd>
      </button>
      <button
        type="button"
        aria-keyshortcuts="a"
        disabled={!hydrated || !canDecide}
        title={why}
        onClick={actions.onAccept}
        className={`${barButton} border border-transparent bg-emerald-700 text-white hover:bg-emerald-800`}
      >
        Accept<Kbd>a</Kbd>
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
}: {
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
    <div className="sticky top-0 z-10 border-b border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2.5">
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
    </div>
  );
}

/** The `?` list. The browser's <dialog> makes the page inert and closes it on Esc. */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="shortcut-help-title"
      onClose={onClose}
      // A click on the scrim is a click on the <dialog> element itself, not on its contents.
      onClick={(event) => event.target === dialog.current && dialog.current?.close()}
      className="mx-auto mt-28 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl backdrop:bg-(--ps-scrim)"
    >
      <h2 id="shortcut-help-title" className="mb-3 text-[17px] font-semibold">
        Keyboard shortcuts
      </h2>
      <dl className="space-y-1.5 text-sm">
        {SHORTCUTS.map(([key, what]) => (
          <div key={key} className="flex items-center justify-between">
            <dt className="text-slate-600">{what}</dt>
            <dd>
              <kbd className="rounded border border-slate-300 px-1.5 font-mono text-xs">{key}</kbd>
            </dd>
          </div>
        ))}
      </dl>
      <form method="dialog" className="mt-4 flex justify-end">
        <button
          type="submit"
          autoFocus
          className={`${barButton} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}
        >
          Close
        </button>
      </form>
    </dialog>
  );
}
