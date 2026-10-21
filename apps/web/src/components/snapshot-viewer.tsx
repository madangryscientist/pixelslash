import { Button } from "@hackcove/ui";
import { useState } from "react";
import { type Crop, changeCrop } from "../../../../packages/engine/src/report-crop.ts";
import { RegionBoxes, type Scale, Viewport } from "#/components/snapshot-frame";
import { SnapshotOverlay } from "#/components/snapshot-overlay";
import { SnapshotSlider } from "#/components/snapshot-slider";
import { useHydrated } from "#/components/ui";
import type { DiffResult } from "#/db/schema";

type Mode = "side" | "overlay" | "slider";

const MODES: { id: Mode; label: string }[] = [
  { id: "side", label: "Side by side" },
  { id: "overlay", label: "Overlay" },
  { id: "slider", label: "Slider" },
];

const SCALES: { id: Scale; label: string; title: string }[] = [
  { id: "fit", label: "Fit", title: "Fit the shot to the stage" },
  { id: "actual", label: "1:1", title: "One screen pixel per shot pixel" },
  { id: "zoom", label: "Zoom to change", title: "Crop to the measured change" },
];

/** One side's measured size, and its caption; all null when nothing measured it. */
function sideSize(result: DiffResult | null, side: "main" | "branch") {
  if (!result) return { width: null, height: null, caption: null };
  const width = side === "main" ? result.mainWidth : result.branchWidth;
  const height = side === "main" ? result.mainHeight : result.branchHeight;
  return { width, height, caption: `${width}×${height}` };
}

/** One row of buttons where exactly one is pressed. */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: { id: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  /** Why an option cannot be picked, by id; absent means it can. */
  disabled?: Partial<Record<T, string>>;
}) {
  const hydrated = useHydrated();
  return (
    <div role="group" aria-label={label} className="flex gap-1">
      {options.map(({ id, label: text, title }) => (
        <Button
          key={id}
          variant={value === id ? "primary" : "outline"}
          aria-pressed={value === id}
          disabled={!hydrated || disabled?.[id] !== undefined}
          title={disabled?.[id] ?? title}
          onClick={() => onChange(id)}
          className="px-3 py-1.5"
        >
          {text}
        </Button>
      ))}
    </div>
  );
}

function Pane({
  label,
  caption,
  url,
  alt,
  empty,
  width,
  height,
  boxes,
  scale,
  crop,
}: {
  label: string;
  caption: string | null;
  url: string | null;
  alt: string;
  empty: string;
  width: number | null;
  height: number | null;
  boxes: DiffResult["regions"] | null;
  scale: Scale;
  crop: Crop | null;
}) {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm font-medium">
        {label}
        {caption && <span className="ml-2 font-normal text-slate-500">{caption}</span>}
      </figcaption>
      {url ? (
        <Viewport width={width} scale={scale} crop={crop}>
          <div className="relative border border-slate-200">
            <img src={url} alt={alt} loading="lazy" className="block w-full" />
            {boxes && width && height && (
              <RegionBoxes width={width} height={height} regions={boxes} />
            )}
          </div>
        </Viewport>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 py-8 text-center text-sm text-slate-500">
          {empty}
        </p>
      )}
    </figure>
  );
}

type Shots = {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  diffUrl: string | null;
  result: DiffResult | null;
  removed: boolean;
};

/** Main and Branch next to each other, each at its own measured size. */
function SideBySide({
  name,
  mainUrl,
  branchUrl,
  result,
  removed,
  regions,
  scale,
  crop,
}: Shots & { regions: DiffResult["regions"] | null; scale: Scale; crop: Crop | null }) {
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
      />
    </div>
  );
}

/** The mode, the highlight and the scale: one row above the stage. */
function ViewerControls({
  mode,
  onMode,
  highlight,
  onHighlight,
  scale,
  onScale,
  measured,
  crop,
}: {
  mode: Mode;
  onMode: (mode: Mode) => void;
  highlight: boolean;
  onHighlight: (on: boolean) => void;
  scale: Scale;
  onScale: (scale: Scale) => void;
  measured: boolean;
  crop: Crop | null;
}) {
  const hydrated = useHydrated();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Segmented label="View mode" options={MODES} value={mode} onChange={onMode} />
      <Button
        variant={highlight ? "primary" : "outline"}
        aria-pressed={highlight}
        disabled={!hydrated || !measured}
        title={measured ? "Draw the measured regions" : "Nothing was measured, so nothing to draw"}
        onClick={() => onHighlight(!highlight)}
        className="px-3 py-1.5"
      >
        Highlight
      </Button>
      <span className="flex-1" />
      <Segmented
        label="Scale"
        options={SCALES}
        value={crop || scale !== "zoom" ? scale : "fit"}
        onChange={onScale}
        disabled={crop ? {} : { zoom: "No measured change to zoom to" }}
      />
    </div>
  );
}

/**
 * The three ways to look at one shot, each at the chosen scale and with or without the measured
 * boxes. Boxes are drawn from the regions the diff stored, nothing is recomputed here; when the two
 * shots differ in size only the measured overlap carries boxes, and the zoom crop is clipped to it.
 */
export function SnapshotViewer(shots: Shots) {
  const [mode, setMode] = useState<Mode>("side");
  const [scale, setScale] = useState<Scale>("fit");
  const [highlight, setHighlight] = useState(true);
  const { result } = shots;
  const crop = result ? changeCrop(result.regions, result.width, result.height) : null;
  const view = { highlight, scale, crop };
  return (
    <section aria-label="Snapshot viewer">
      <ViewerControls
        mode={mode}
        onMode={setMode}
        highlight={highlight}
        onHighlight={setHighlight}
        scale={scale}
        onScale={setScale}
        measured={result !== null}
        crop={crop}
      />
      {mode === "side" && (
        <SideBySide {...shots} regions={result && highlight ? result.regions : null} {...view} />
      )}
      {mode === "overlay" && <SnapshotOverlay {...shots} {...view} />}
      {mode === "slider" && <SnapshotSlider {...shots} {...view} />}
    </section>
  );
}
