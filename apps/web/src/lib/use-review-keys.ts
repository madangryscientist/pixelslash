import { useEffect } from "react";

/** A keystroke typed into a control belongs to that control, not to the review walk. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [contenteditable]") !== null
  );
}

export type ReviewKeyAction = "next" | "previous" | "accepted" | "rejected" | "help";

/** j/k walk whatever the build's state; a/r decide a shot, so they need `canDecide`. `?` lists them. */
export function reviewKeyAction(key: string, canDecide: boolean): ReviewKeyAction | null {
  if (key === "?") return "help";
  if (key === "j") return "next";
  if (key === "k") return "previous";
  if (!canDecide) return null;
  if (key === "a") return "accepted";
  if (key === "r") return "rejected";
  return null;
}

/**
 * j/k walk the build in its review order, a/r decide the shot on screen, `?` opens the shortcut
 * list. A modified key belongs to the browser. While that list is open no key walks or decides,
 * wherever focus is: the browser closes it on Esc.
 */
export function useReviewKeys(opts: {
  canDecide: boolean;
  nextId: string | null;
  previousId: string | null;
  go: (id: string | null) => void;
  decide: (state: "accepted" | "rejected") => void;
  help: () => void;
  helpOpen: boolean;
}) {
  const { canDecide, nextId, previousId, go, decide, help, helpOpen } = opts;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modified = event.metaKey || event.ctrlKey || event.altKey;
      if (helpOpen || modified || isTyping(event.target)) return;
      const action = reviewKeyAction(event.key, canDecide);
      if (action === "next") go(nextId);
      else if (action === "previous") go(previousId);
      else if (action === "help") help();
      else if (action) decide(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canDecide, nextId, previousId, go, decide, help, helpOpen]);
}
