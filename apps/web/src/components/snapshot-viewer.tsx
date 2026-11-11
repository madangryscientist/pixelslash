import { type ReactNode, useState } from "react";
import { type Crop, changeCrop } from "../../../../packages/engine/src/report-crop.ts";
import type { Composition } from "#/components/composition";
import { type Mode, type PanelToggle, ViewerControls } from "#/components/snapshot-controls";
import type { Scale } from "#/components/snapshot-frame";
import { type Marking, Pane } from "#/components/snapshot-pane";
import { OverlayControls, SnapshotOverlay, useOverlay } from "#/components/snapshot-overlay";
import { SliderControls, SnapshotSlider, useSlider } from "#/components/snapshot-slider";
import type { DiffResult, IgnoreRect } from "#/db/schema";

/** One side's measured size, and its caption; all null when nothing measured it. */
function sideSize(result: DiffResult | null, side: "main" | "branch") {
  if (!result) return { width: null, height: null, caption: null };
  const width = side === "main" ? result.mainWidth : result.branchWidth;
  const height = side === "main" ? result.mainHeight : result.branchHeight;
  return { width, height, caption: `${width}×${height}` };
}

type Shots = {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  diffUrl: string | null;
  result: DiffResult | null;
  removed: boolean;
  /** The branch's composition findings (ob 1850); drawn on the branch pane only. */
  composition?: Composition | null | undefined;
};

/** Main and Branch next to each other, each at its own measured size. */
function SideBySide({
  name,
  mainUrl,
  branchUrl,
  result,
  removed,
  composition,
  showFindings,
  highlight,
  scale,
  crop,
  marks,
  onDraw,
  ignored,
}: Shots &
  Marking & { showFindings: boolean; highlight: boolean; scale: Scale; crop: Crop | null }) {
  const marking = { marks, onDraw, ignored };
  const regions = result && highlight ? result.regions : null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Pane
        label="Main (baseline)"
        {...sideSize(result, "main")}
        url={mainUrl}
        alt={`${name} on main`}
        empty="No baseline to compare with."
        boxes={regions}
        scale={scale}
        crop={crop}
        {...marking}
      />
      <Pane
        label="Branch"
        {...sideSize(result, "branch")}
        url={branchUrl}
        alt={`${name} on the branch`}
        empty={removed ? "The branch no longer has this shot." : "This shot has no branch image."}
        boxes={regions}
        scale={scale}
        crop={crop}
        composition={showFindings ? composition : null}
        {...marking}
      />
    </div>
  );
}

/**
 * A drawn box clipped to the compared overlap (top-left, the smaller of the two sizes), where Main
 * and Branch share px: the same box then means the same pixels on either side. Null when nothing
 * of it is inside.
 */
function clipToOverlap(rect: IgnoreRect, result: DiffResult): IgnoreRect | null {
  const width = Math.min(rect.x + rect.width, result.width) - rect.x;
  const height = Math.min(rect.y + rect.height, result.height) - rect.y;
  return width > 0 && height > 0 ? { ...rect, width, height } : null;
}

/** `onDraw`, taking only what lands in the overlap; nothing to draw on when nothing was measured. */
function overlapDraw(onDraw: Marking["onDraw"], result: DiffResult | null): Marking["onDraw"] {
  if (!onDraw || !result) return null;
  return (rect) => {
    const clipped = clipToOverlap(rect, result);
    if (clipped) onDraw(clipped);
  };
}

/** The crop to the measured change; none when nothing was measured. */
function cropOf(result: DiffResult | null): Crop | null {
  return result ? changeCrop(result.regions, result.width, result.height) : null;
}

/** How the shot is being looked at; the page holds it, because the side panel folds away at Fit. */
export type ViewState = {
  mode: Mode;
  onMode: (mode: Mode) => void;
  scale: Scale;
  onScale: (scale: Scale) => void;
};

export function useViewState(): ViewState {
  const [mode, onMode] = useState<Mode>("side");
  const [scale, onScale] = useState<Scale>("fit");
  return { mode, onMode, scale, onScale };
}

/**
 * The three ways to look at one shot, each at the chosen scale and with or without the measured
 * boxes. Boxes are drawn from the regions the diff stored, nothing is recomputed here; when the two
 * shots differ in size only the measured overlap carries boxes, and the zoom crop is clipped to it.
 */
export function SnapshotViewer({
  marks = [],
  onDraw = null,
  ignored = [],
  view,
  panel,
  ...shots
}: Shots & Partial<Marking> & { view: ViewState; panel: PanelToggle | null }) {
  // An area is drawn on Main or Branch as they stand; overlay and slider move the images around.
  const mode = onDraw ? "side" : view.mode;
  const { scale } = view;
  // Off on load: the shot is read as it is first, and the boxes are asked for.
  const [highlight, setHighlight] = useState(false);
  const [showFindings, setShowFindings] = useState(true);
  const slider = useSlider();
  const overlay = useOverlay();
  const { result } = shots;
  const crop = cropOf(result);
  const draw = overlapDraw(onDraw, result);
  const shown = { highlight, scale, crop };
  let modeControls: ReactNode = null;
  if (mode === "slider")
    modeControls = <SliderControls slider={slider} branchUrl={shots.branchUrl} />;
  if (mode === "overlay")
    modeControls = <OverlayControls overlay={overlay} diffUrl={shots.diffUrl} />;
  return (
    <section aria-label="Snapshot viewer">
      <ViewerControls
        mode={mode}
        onMode={view.onMode}
        highlight={highlight}
        onHighlight={setHighlight}
        scale={scale}
        onScale={view.onScale}
        measured={result !== null}
        crop={crop}
        composition={shots.composition}
        showFindings={showFindings}
        onShowFindings={setShowFindings}
        modeControls={modeControls}
        panel={panel}
      />
      {mode === "side" && (
        <SideBySide
          {...shots}
          showFindings={showFindings}
          {...shown}
          marks={marks}
          onDraw={draw}
          ignored={ignored}
        />
      )}
      {mode === "overlay" && <SnapshotOverlay {...shots} {...shown} overlay={overlay} />}
      {mode === "slider" && <SnapshotSlider {...shots} {...shown} slider={slider} />}
    </section>
  );
}
