import { Cluster, ClusterGrow, SegmentedControl, ToggleChip } from "@hackcove/ui";
import type { ReactNode } from "react";
import type { Crop } from "../../../../packages/engine/src/report-crop.ts";
import { type Composition, CompositionLegend } from "#/components/composition";
import type { Scale } from "#/components/snapshot-frame";
import { useHydrated } from "#/components/ui";

export type Mode = "side" | "overlay" | "slider";

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

/** One row of options where exactly one is chosen; `disabled` is why an option cannot be, by id. */
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
  disabled?: Partial<Record<T, string>>;
}) {
  const hydrated = useHydrated();
  return (
    <SegmentedControl
      label={label}
      value={value}
      disabled={!hydrated}
      onChange={(id) => {
        const option = options.find((candidate) => candidate.id === id);
        if (option) onChange(option.id);
      }}
      items={options.map(({ id, label: text, title }) => {
        const why = disabled?.[id];
        const reason = why ?? title;
        return {
          value: id,
          label: text,
          disabled: why !== undefined,
          ...(reason === undefined ? {} : { title: reason }),
        };
      })}
    />
  );
}

/** The composition findings' toggle and legend; the boxes are drawn side by side only. */
function CompositionToggle({
  composition,
  side,
  on,
  onChange,
}: {
  composition: Composition;
  side: boolean;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const hydrated = useHydrated();
  return (
    <>
      <ToggleChip
        pressed={on}
        disabled={!hydrated || !side}
        title={
          side ? "Draw the composition findings on Branch" : "Findings are drawn side by side only"
        }
        onClick={() => onChange(!on)}
      >
        Composition
      </ToggleChip>
      {on && side && <CompositionLegend composition={composition} />}
    </>
  );
}

/** Findings worth a toggle: a composition that found nothing has nothing to draw. */
const hasFindings = (composition: Composition | null | undefined): composition is Composition =>
  !!composition && composition.gaps.length + composition.special.length > 0;

/**
 * The mode (and the slider's own controls beside it), then the toggles that draw on the shot, then
 * the scale: one row above the stage.
 */
export function ViewerControls({
  mode,
  onMode,
  highlight,
  onHighlight,
  scale,
  onScale,
  measured,
  crop,
  composition,
  showFindings,
  onShowFindings,
  slider,
}: {
  mode: Mode;
  onMode: (mode: Mode) => void;
  highlight: boolean;
  onHighlight: (on: boolean) => void;
  scale: Scale;
  onScale: (scale: Scale) => void;
  measured: boolean;
  crop: Crop | null;
  composition: Composition | null | undefined;
  showFindings: boolean;
  onShowFindings: (on: boolean) => void;
  /** The slider's range and onion toggle, shown in slider mode. */
  slider?: ReactNode;
}) {
  const hydrated = useHydrated();
  return (
    <Cluster gap="xs" wrap>
      <Segmented label="View mode" options={MODES} value={mode} onChange={onMode} />
      {mode === "slider" && slider}
      {/* Gap: hackcove has no vertical divider; this sets Highlight apart from the mode switcher. */}
      <span aria-hidden className="h-5 border-l border-slate-200" />
      <ToggleChip
        pressed={highlight}
        disabled={!hydrated || !measured}
        title={measured ? "Draw the measured regions" : "Nothing was measured, so nothing to draw"}
        onClick={() => onHighlight(!highlight)}
      >
        Highlight
      </ToggleChip>
      {hasFindings(composition) && (
        <CompositionToggle
          composition={composition}
          side={mode === "side"}
          on={showFindings}
          onChange={onShowFindings}
        />
      )}
      <ClusterGrow />
      <Segmented
        label="Scale"
        options={SCALES}
        value={crop || scale !== "zoom" ? scale : "fit"}
        onChange={onScale}
        disabled={crop ? {} : { zoom: "No measured change to zoom to" }}
      />
    </Cluster>
  );
}
