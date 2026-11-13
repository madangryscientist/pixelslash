import { type ReactNode, useState } from "react";
import { type Crop, changeCrop } from "../../../../packages/engine/src/report-crop.ts";
import type { Composition } from "#/components/composition";
import { BaseSwitch } from "#/components/snapshot-base";
import { type Mode, type PanelToggle, ViewerControls } from "#/components/snapshot-controls";
import type { Scale } from "#/components/snapshot-frame";
import { type Marking, Pane } from "#/components/snapshot-pane";
import { OverlayControls, SnapshotOverlay, useOverlay } from "#/components/snapshot-overlay";
import { SliderControls, SnapshotSlider, useSlider } from "#/components/snapshot-slider";
import type { DiffResult, IgnoreRect } from "#/db/schema";
import {
  type Base,
  type BaseId,
  type BaseNames,
  type Bases,
  MAIN_NAMES,
  chosenBase,
} from "#/lib/viewer-bases";

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
  /** How the left side is named; "Main (baseline)" unless the shot was compared with an earlier build. */
  names?: BaseNames;
};

/** Main (or the earlier build) and Branch next to each other, each at its own measured size. */
function SideBySide({
  name,
  names = MAIN_NAMES,
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
        label={names.pane}
        {...sideSize(result, "main")}
        url={mainUrl}
        alt={`${name} ${names.alt}`}
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
  /** The comparison chosen, and for which shot: a choice made on another shot does not carry over. */
  base: { snapshotId: string; id: BaseId } | null;
  onBase: (base: { snapshotId: string; id: BaseId }) => void;
};

export function useViewState(): ViewState {
  const [mode, onMode] = useState<Mode>("side");
  const [scale, onScale] = useState<Scale>("fit");
  const [base, onBase] = useState<ViewState["base"]>(null);
  return { mode, onMode, scale, onScale, base, onBase };
}

/** The pair on screen: the shot's own, unless the reviewer (or a carried shot) opens on main. */
function pairOf(
  given: Shots,
  bases: Bases | null,
  picked: ViewState["base"],
  snapshotId: string,
): { base: Base | null; shots: Shots & { names: BaseNames }; boxesByDefault: boolean } {
  const base = bases
    ? chosenBase(bases, picked?.snapshotId === snapshotId ? picked.id : null)
    : null;
  if (!base)
    return { base, shots: { ...given, names: given.names ?? MAIN_NAMES }, boxesByDefault: false };
  const { names, mainUrl, diffUrl, result, boxesByDefault } = base;
  return { base, shots: { ...given, names, mainUrl, diffUrl, result }, boxesByDefault };
}

/** The toolbar part that belongs to the slider or the overlay; nothing for side by side. */
function modeControlsOf(
  mode: Mode,
  slider: ReturnType<typeof useSlider>,
  overlay: ReturnType<typeof useOverlay>,
  shots: Shots & { names: BaseNames },
): ReactNode {
  if (mode === "slider")
    return (
      <SliderControls slider={slider} branchUrl={shots.branchUrl} baseName={shots.names.short} />
    );
  if (mode === "overlay") return <OverlayControls overlay={overlay} diffUrl={shots.diffUrl} />;
  return null;
}

/** What the left pane is compared with, above the toolbar; nothing when only main is on offer. */
function compareSwitch(
  bases: Bases | null,
  base: Base | null,
  onSelect: (id: BaseId) => void,
): ReactNode {
  if (!bases || !base) return null;
  return <BaseSwitch bases={bases} selected={base.id} summary={base.summary} onSelect={onSelect} />;
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
  snapshotId,
  bases,
  ...given
}: Shots &
  Partial<Marking> & {
    view: ViewState;
    panel: PanelToggle | null;
    snapshotId: string;
    /** What the shot can be compared with; null reads as main's baseline, the only pair. */
    bases: Bases | null;
  }) {
  const { base, shots, boxesByDefault } = pairOf(given, bases, view.base, snapshotId);
  // An area is drawn on Main or Branch as they stand; overlay and slider move the images around.
  const mode = onDraw ? "side" : view.mode;
  const { scale } = view;
  // Off on load: the shot is read as it is first, and the boxes are asked for. Opening on main to
  // decide a carried change is the exception: the change is what is being decided.
  const [asked, setHighlight] = useState<boolean | null>(null);
  const highlight = asked ?? boxesByDefault;
  const [showFindings, setShowFindings] = useState(true);
  const slider = useSlider();
  const overlay = useOverlay();
  const { result } = shots;
  const crop = cropOf(result);
  const draw = overlapDraw(onDraw, result);
  const shown = { highlight, scale, crop };
  return (
    <section aria-label="Snapshot viewer">
      {compareSwitch(bases, base, (id) => view.onBase({ snapshotId, id }))}
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
        modeControls={modeControlsOf(mode, slider, overlay, shots)}
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
