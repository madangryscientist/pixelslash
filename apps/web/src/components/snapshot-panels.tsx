import { type ReactNode, useEffect, useRef } from "react";
import {
  Button,
  ButtonGroup,
  Cluster,
  ClusterGrow,
  Dialog,
  Kbd,
  KeyValue,
  KeyValueList,
  Pill,
  SubsectionHeading,
  Text,
} from "@hackcove/ui-react";
import { ReviewChip, StatusBadge, useHydrated } from "#/components/ui";
import type { BuildView, SnapshotView } from "#/db/review";
import { formatDateTime } from "#/lib/format";
import { type ShotLabel, titleWords, variantChips } from "#/lib/shot-label";

/** Every key the page answers to, for the `?` list. */
const SHORTCUTS: [string, string][] = [
  ["j", "Next shot"],
  ["k", "Previous shot"],
  ["a", "Accept this shot"],
  ["r", "Reject this shot"],
  ["?", "Show these shortcuts"],
  ["Esc", "Close this list"],
];

type Review = { index: number | null; total: number };

function reviewText(review: Review): string {
  if (review.index !== null) return `change ${review.index} of ${review.total}`;
  if (review.total === 0) return "nothing to review";
  return `not to review · ${review.total} with a change`;
}

/** The readable name, with the raw key as its tooltip. */
function ShotTitle({ snapshot, label }: { snapshot: SnapshotView; label: ShotLabel }) {
  const title = label.component ? `${label.component} · ${label.story}` : label.story;
  return (
    <SubsectionHeading as="h1" size="md" truncate title={snapshot.name}>
      {title}
    </SubsectionHeading>
  );
}

/**
 * The shot's own variant: its colour scheme and viewport, once, for both panes (a snapshot has
 * exactly one of each), then the chips its name carries. "mode" keeps the scheme apart from a
 * Storybook theme chip.
 */
function variantPills(snapshot: SnapshotView, label: ShotLabel): string[] {
  return [`${titleWords(snapshot.theme)} mode`, snapshot.viewport, ...variantChips(label)];
}

/** The variant chips, the build's status, and this shot's decision: none of them truncate, so the title gives way. */
function ShotMeta({
  build,
  snapshot,
  label,
}: {
  build: BuildView["build"];
  snapshot: SnapshotView;
  label: ShotLabel;
}) {
  return (
    <>
      {variantPills(snapshot, label).map((chip) => (
        <Pill key={chip} tone="slate" data-testid="shot-chip">
          {chip}
        </Pill>
      ))}
      <StatusBadge status={build.status} />
      <ReviewChip state={snapshot.reviewState} by={snapshot.reviewedBy} />
      {/* The date is the first thing a narrow row gives up: below xl the title keeps the room. */}
      {snapshot.reviewedAt && (
        <div className="hidden xl:block">
          <Text tone="muted">{formatDateTime(snapshot.reviewedAt)}</Text>
        </div>
      )}
    </>
  );
}

/** The key that does the same as a button; a phone has no keys, so it gives the room back. */
function KeyHint({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="hidden sm:inline">
      <Kbd>{children}</Kbd>
    </span>
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
    <ButtonGroup>
      <Button
        variant="outline"
        size="sm"
        aria-label="Previous shot"
        aria-keyshortcuts="k"
        disabled={!hydrated || !onPrevious}
        onClick={() => onPrevious?.()}
      >
        ‹ <KeyHint>k</KeyHint>
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-label="Next shot"
        aria-keyshortcuts="j"
        disabled={!hydrated || !onNext}
        onClick={() => onNext?.()}
      >
        › <KeyHint>j</KeyHint>
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-expanded={actions.flagOpen}
        pressed={actions.flagOpen}
        disabled={!hydrated}
        title="Missed change or false positive: tell PixelSlash the diff got this shot wrong"
        onClick={actions.onFlag}
      >
        Flag detection
      </Button>
      <Button
        variant="outline"
        size="sm"
        tone="danger"
        aria-keyshortcuts="r"
        disabled={!hydrated || !canDecide}
        title={why}
        onClick={actions.onReject}
      >
        Reject <KeyHint>r</KeyHint>
      </Button>
      <Button
        size="sm"
        tone="positive"
        aria-keyshortcuts="a"
        disabled={!hydrated || !canDecide}
        title={why}
        onClick={actions.onAccept}
      >
        Accept <KeyHint>a</KeyHint>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        data-testid="keyboard-hint"
        aria-label="Keyboard shortcuts"
        aria-keyshortcuts="?"
        disabled={!hydrated}
        onClick={actions.onHelp}
      >
        ?
      </Button>
    </ButtonGroup>
  );
}

/** The CSS variable the sticky bar's height is published under, for what sticks below it. */
const BAR_HEIGHT_VAR = "--shot-bar";

/**
 * Publishes the sticky bar's height as `--shot-bar` on the layout that holds it, so the pane
 * labels and the side rail can stick right under the bar however far it wraps. The bar is the
 * `StickyBar` around this component; the layout is its parent, which React does not style.
 */
function usePublishBarHeight() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = ref.current?.parentElement;
    const layout = bar?.parentElement;
    if (!bar || !layout) return undefined;
    const publish = () => layout.style.setProperty(BAR_HEIGHT_VAR, `${bar.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      layout.style.removeProperty(BAR_HEIGHT_VAR);
    };
  }, []);
  return ref;
}

/**
 * The side rail's content, from lg where the rail sits beside the image: it sticks under the bar,
 * so a tall shot does not leave the column empty. One taller than what is left scrolls inside itself.
 */
export function StickyRail({ children }: { children: ReactNode }) {
  return (
    <div className="lg:sticky lg:top-[calc(var(--app-header,0px)+var(--shot-bar,6rem)+1rem)] lg:max-h-[calc(100vh-var(--app-header,0px)-var(--shot-bar,6rem)-2rem)] lg:overflow-y-auto">
      {children}
    </div>
  );
}

/**
 * The bar that stays on screen: what this shot is, where it sits in the review, and the decision.
 * The review position counts the changed shots; the build position, the whole j/k walk.
 *
 * On a phone the title has its own row, the chips and counters wrap onto the row below it, and the
 * breadcrumbs leave the bar (the page shows them above it, scrolling away), so the bar stays short.
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
  const ref = usePublishBarHeight();
  return (
    <div ref={ref} data-testid="viewer-bar">
      <div className="flex flex-col gap-1 sm:gap-2">
        <div className="hidden sm:block">{breadcrumbs}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* The title keeps at least 17rem, so beside it only what fits; the rest wraps under it. */}
          <ClusterGrow minWidth="md">
            <ShotTitle snapshot={snapshot} label={label} />
          </ClusterGrow>
          <div
            data-testid="shot-meta"
            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 [&_*]:whitespace-nowrap"
          >
            <ShotMeta build={build} snapshot={snapshot} label={label} />
            <Text data-testid="review-position" tone="muted" numeric>
              {reviewText(review)}
            </Text>
            <Text data-testid="position" tone="muted" numeric>
              {`shot ${position} of ${total}`}
            </Text>
          </div>
        </div>
        <Cluster justify="end">
          <Actions actions={actions} canDecide={reviewable && !busy} why={why} />
        </Cluster>
      </div>
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
        <Button
          variant="outline"
          autoFocus
          onClick={(event) => event.currentTarget.closest("dialog")?.close()}
        >
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
