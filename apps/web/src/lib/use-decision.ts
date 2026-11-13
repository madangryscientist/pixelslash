import { useCallback, useRef, useState } from "react";
import type { BuildStatus } from "#/db/schema";

export type DecisionState = "accepted" | "rejected";

/** What a decision on the server answers: the build's status after the write, and the next shot to review. */
export type DecisionReply = { buildStatus: BuildStatus; nextToReviewId: string | null };

type Options = {
  /** False when the build takes no decisions: `decide` then does nothing. */
  reviewable: boolean;
  /** Sends the decision to the server. */
  review: (state: DecisionState) => Promise<DecisionReply>;
  /** Moves to another shot of the build. */
  go: (id: string | null) => void;
  /** Moves to the build page. */
  toBuild: () => void;
};

/**
 * Accept or reject the shot on screen. An accept that lands moves the reviewer on to the next shot
 * still awaiting one, or to the build page when none is left; the reply carries that shot, read
 * after the decision because this shot's loaded data predates decisions made on the others since it
 * was opened, so a decision is one server call. A reject always goes to the build page: it fails
 * the build, and a failed build takes no more decisions, so the next shot would be a dead screen.
 * Only a refused decision is an error.
 */
export function useDecision({ reviewable, review, go, toBuild }: Options) {
  const [busy, setBusy] = useState(false);
  // A ref as well as state: a second key in the same task as the first must see the first in flight.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const decide = useCallback(
    (state: DecisionState) => {
      if (!reviewable || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      review(state)
        .then(
          (reply) => {
            // Another reviewer's reject can land between this accept and the reply: the build is failed then.
            const stillDecidable =
              reply.buildStatus === "changes" || reply.buildStatus === "passed";
            if (state === "accepted" && reply.nextToReviewId && stillDecidable)
              go(reply.nextToReviewId);
            else toBuild();
          },
          (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => {
          inFlight.current = false;
          setBusy(false);
        });
    },
    [reviewable, review, go, toBuild],
  );
  return { busy, error, decide };
}
