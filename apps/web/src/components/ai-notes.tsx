import { type ReactNode, createContext, useContext } from "react";
import { Body, BodyStrong, Caption, Overline, Stack } from "@hackcove/ui";
import type { SnapshotView } from "#/db/review";
import type { AiRegionNote, DiffRegion } from "#/db/schema";

/**
 * The project model's notes on a shot's changed regions (ob 1473). The viewer's boxes read them
 * from here, so the overlay, slider and side-by-side views need no new props to show them.
 */
const RegionNotes = createContext<AiRegionNote[]>([]);

export function RegionNotesProvider({
  notes,
  children,
}: {
  notes: AiRegionNote[];
  children: ReactNode;
}) {
  return <RegionNotes.Provider value={notes}>{children}</RegionNotes.Provider>;
}

/** The note the model gave this region, matched on its box; none for a region it was not asked about. */
export function useRegionNote(region: DiffRegion): AiRegionNote | undefined {
  return useContext(RegionNotes).find(
    (note) =>
      note.x === region.x && note.y === region.y && note.w === region.w && note.h === region.h,
  );
}

/** Accepted because the model called every changed region noise, not by a person (ob 1473). */
export function aiFiltered(shot: SnapshotView): boolean {
  return (
    shot.aiReview?.autoPassed === true &&
    shot.reviewState === "accepted" &&
    shot.reviewedBy === null
  );
}

/** "2 noise, 1 intended": the labels of a shot's notes, for a card. */
export function labelSummary(notes: AiRegionNote[]): string {
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note.label, (counts.get(note.label) ?? 0) + 1);
  return [...counts].map(([label, n]) => `${n} ${label}`).join(", ");
}

/**
 * The side panel's section: each changed region's label and sentence; "explaining…" while the shot
 * waits on the explain queue (ob 1875); or, for a changed shot the model did not explain (no model,
 * or the calls failed, and why), that it is reviewed as plain pixels.
 */
export function AiExplanation({ snapshot }: { snapshot: SnapshotView }) {
  const review = snapshot.aiReview;
  if (!review) {
    if (snapshot.diffStatus !== "changed") return null;
    return (
      <Stack as="section" gap="xs" data-testid="ai-explanation">
        <Overline as="h2" tone="muted">
          AI explanation
        </Overline>
        {snapshot.aiPending ? (
          <Body as="p" tone="muted" data-testid="ai-pending">
            explaining…
          </Body>
        ) : (
          <>
            <Body as="p" tone="muted" data-testid="ai-skip">
              skip: no judge. Review the pixels.
            </Body>
            {snapshot.aiError && (
              <Caption as="p" tone="muted" data-testid="ai-error">
                {snapshot.aiError}
              </Caption>
            )}
          </>
        )}
      </Stack>
    );
  }
  return (
    <Stack as="section" gap="xs" data-testid="ai-explanation">
      <Overline as="h2" tone="muted">
        AI explanation
      </Overline>
      {aiFiltered(snapshot) && (
        <BodyStrong as="p" data-testid="ai-auto-passed">
          Auto-passed: every changed region was labelled noise.
        </BodyStrong>
      )}
      <Stack as="ul" gap="xs">
        {review.regions.map((note) => (
          <li key={`${note.x},${note.y},${note.w},${note.h}`} data-testid="ai-region-note">
            <BodyStrong data-testid="ai-label">{note.label}</BodyStrong>
            <Body tone="muted">
              {" "}
              at {note.x},{note.y} ({note.w}×{note.h})
            </Body>
            <Body as="p">{note.explanation}</Body>
          </li>
        ))}
      </Stack>
      <Caption as="p" tone="muted">
        {review.model}
      </Caption>
    </Stack>
  );
}
