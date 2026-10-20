import { useEffect } from "react";

/** A keystroke typed into a control belongs to that control, not to the review walk. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [contenteditable]") !== null
  );
}

/**
 * j/k walk the build in its review order, a/r decide the shot on screen. A modified key belongs
 * to the browser.
 */
export function useReviewKeys(opts: {
  enabled: boolean;
  nextId: string | null;
  previousId: string | null;
  go: (id: string | null) => void;
  decide: (state: "accepted" | "rejected") => void;
}) {
  const { enabled, nextId, previousId, go, decide } = opts;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modified = event.metaKey || event.ctrlKey || event.altKey;
      if (!enabled || modified || isTyping(event.target)) return;
      const actions: Record<string, () => void> = {
        j: () => go(nextId),
        k: () => go(previousId),
        a: () => decide("accepted"),
        r: () => decide("rejected"),
      };
      actions[event.key]?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, nextId, previousId, go, decide]);
}
