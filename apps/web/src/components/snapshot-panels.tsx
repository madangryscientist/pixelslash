import { type ReactNode } from "react";
import {
  Body,
  Button,
  ButtonGroup,
  Cluster,
  ClusterGrow,
  Container,
  Dialog,
  Kbd,
  KeyValue,
  KeyValueList,
  Pill,
  SubsectionHeading,
} from "@hackcove/ui";
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
      <SubsectionHeading as="h1" size="base" title={snapshot.name}>
        {title}
      </SubsectionHeading>
      {variantChips(label).map((chip) => (
        <Pill key={chip} tone="slate">
          {chip}
        </Pill>
      ))}
      <StatusBadge status={build.status} />
      <ReviewChip state={snapshot.reviewState} by={snapshot.reviewedBy} />
      {snapshot.reviewedAt && <Body tone="muted">{formatDateTime(snapshot.reviewedAt)}</Body>}
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
        ‹ <Kbd aria-hidden="true">k</Kbd>
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-label="Next shot"
        aria-keyshortcuts="j"
        disabled={!hydrated || !onNext}
        onClick={() => onNext?.()}
      >
        › <Kbd aria-hidden="true">j</Kbd>
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
        Reject <Kbd aria-hidden="true">r</Kbd>
      </Button>
      <Button
        size="sm"
        tone="positive"
        aria-keyshortcuts="a"
        disabled={!hydrated || !canDecide}
        title={why}
        onClick={actions.onAccept}
      >
        Accept <Kbd aria-hidden="true">a</Kbd>
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
        <Cluster gap="sm" wrap>
          <ShotTitle build={build} snapshot={snapshot} label={label} />
          <ClusterGrow />
          <Body data-testid="review-position" tone="muted" numeric>
            {reviewText(review)}
          </Body>
          <Body data-testid="position" tone="muted" numeric>
            {position} of {total}
          </Body>
          <Actions actions={actions} canDecide={reviewable && !busy} why={why} />
        </Cluster>
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
