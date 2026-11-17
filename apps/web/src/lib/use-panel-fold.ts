import { useState } from "react";
import type { PanelToggle } from "#/components/snapshot-controls";
import type { ViewState } from "#/components/snapshot-viewer";
import { useWide } from "#/lib/use-wide";

/**
 * At Fit, side by side, on a wide screen, the side panel folds away so the two panes get the whole
 * width; the toggle brings it back. It stays open while a task in it needs it (flagging, drawing
 * an ignore area), and below `lg` it is a stack under the image as ever. Null when it never folds.
 */
export function usePanelFold(
  view: ViewState,
  busy: boolean,
): { folded: boolean; toggle: PanelToggle | null } {
  const wide = useWide();
  const [reopened, setReopened] = useState(false);
  const folds = wide && view.mode === "side" && view.scale === "fit";
  if (!folds) return { folded: false, toggle: null };
  const folded = !reopened && !busy;
  return {
    folded,
    toggle: { shown: !folded, locked: busy, onToggle: () => setReopened(folded) },
  };
}
