import { useEffect } from "react";

/** A keystroke typed into a control belongs to that control, not to the review walk. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [contenteditable]") !== null
  );
}

export type ReviewKeyAction = "next" | "previous" | "accepted" | "rejected";

/** j/k walk whatever the build's state; a/r decide a shot, so they need `canDecide`. */
export function reviewKeyAction(key: string, canDecide: boolean): ReviewKeyAction | null {
  if (key === "j") return "next";
  if (key === "k") return "previous";
  if (!canDecide) return null;
  if (key === "a") return "accepted";
  if (key === "r") return "rejected";
  return null;
}

/**
 * j/k walk the build in its review order, a/r decide the shot on screen. A modified key belongs
 * to the browser.
 */
export function useReviewKeys(opts: {
  canDecide: boolean;
  nextId: string | null;
  previousId: string | null;
  go: (id: string | null) => void;
  decide: (state: "accepted" | "rejected") => void;
}) {
  const { canDecide, nextId, previousId, go, decide } = opts;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modified = event.metaKey || event.ctrlKey || event.altKey;
      if (modified || isTyping(event.target)) return;
      const action = reviewKeyAction(event.key, canDecide);
      if (action === "next") go(nextId);
      else if (action === "previous") go(previousId);
      else if (action) decide(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canDecide, nextId, previousId, go, decide]);
}
