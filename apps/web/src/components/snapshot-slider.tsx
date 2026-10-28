import { Caption, Pill, ToggleChip } from "@hackcove/ui";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import type { Crop } from "../../../../packages/engine/src/report-crop.ts";
import { RegionBoxes, type Scale, Viewport } from "#/components/snapshot-frame";
import { useHydrated } from "#/components/ui";
import type { DiffResult } from "#/db/schema";

/** Where the divider sits (0 is all Branch, 100 all Main), or Branch's opacity in onion skin. */
type SliderState = {
  position: number;
  onion: boolean;
  setPosition: (position: number) => void;
  setOnion: (onion: boolean) => void;
};

const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

/** Held by the viewer: the toolbar's range and the handle on the image move the same divider. */
export function useSlider(): SliderState {
  const [position, setRaw] = useState(50);
  const [onion, setOnion] = useState(false);
  const setPosition = useCallback((n: number) => setRaw(clamp(n)), []);
  return { position, onion, setPosition, setOnion };
}

/** The handle's keys: arrows step 1 (10 with Shift), Page Up/Down 10, Home and End the ends. */
function keyStep(event: KeyboardEvent, position: number): number | null {
  const step = event.shiftKey ? 10 : 1;
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") return position - step;
  if (event.key === "ArrowRight" || event.key === "ArrowUp") return position + step;
  if (event.key === "PageDown") return position - 10;
  if (event.key === "PageUp") return position + 10;
  if (event.key === "Home") return 0;
  if (event.key === "End") return 100;
  return null;
}

/**
 * The divider's grip: a focusable `role=slider`, so the wipe works without a pointer. A Pill marks
 * where the wipe sits; hackcove has no Slider, so there is no coloured divider line of our own.
 */
function Handle({ slider }: { slider: SliderState }) {
  const { position, setPosition } = slider;
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Divider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={position}
      aria-valuetext={`Main to ${position}%, Branch after`}
      onKeyDown={(event) => {
        const next = keyStep(event, position);
        if (next === null) return;
        event.preventDefault();
        setPosition(next);
      }}
      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none"
      style={{ left: `${position}%` }}
    >
      <Pill tone="violet" round>
        ↔
      </Pill>
    </div>
  );
}

/** A pointer pressed anywhere on the image moves the divider there and drags it until released. */
function useDrag(setPosition: (n: number) => void) {
  const frame = useRef<HTMLDivElement>(null);
  const moveTo = (event: PointerEvent) => {
    const box = frame.current?.getBoundingClientRect();
    if (box && box.width > 0) setPosition(((event.clientX - box.left) / box.width) * 100);
  };
  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      moveTo(event);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTo(event);
    },
  };
  return { frame, handlers };
}

/**
 * Main underneath, Branch on top over the same frame: both images are sized as a share of the
 * frame (the wider shot), so a pixel of one sits on the same pixel of the other. The wipe clips
 * Branch from the divider rightwards; onion skin fades it instead.
 */
function ShotLayers({
  name,
  mainUrl,
  branchUrl,
  slider,
  mains,
  branches,
  boxes,
}: {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  slider: SliderState;
  mains: string;
  branches: string;
  boxes: ReactNode;
}) {
  const { position, onion } = slider;
  const wipe = !onion && branchUrl !== null;
  const { frame, handlers } = useDrag(slider.setPosition);
  return (
    <div
      ref={frame}
      data-testid="slider-frame"
      className={`relative overflow-hidden ${wipe ? "cursor-ew-resize select-none" : ""}`}
      {...(wipe ? handlers : {})}
    >
      {mainUrl ? (
        <img
          src={mainUrl}
          alt={`${name} on main`}
          className="block"
          draggable={false}
          style={{ width: mains }}
          data-testid="slider-main"
        />
      ) : (
        <div style={{ paddingBottom: "40%" }} />
      )}
      {branchUrl && (
        <div
          className="absolute inset-0"
          style={onion ? { opacity: position / 100 } : { clipPath: `inset(0 0 0 ${position}%)` }}
        >
          <img
            src={branchUrl}
            alt={`${name} on the branch`}
            className="absolute top-0 left-0 max-w-none"
            draggable={false}
            style={{ width: branches }}
            data-testid="slider-branch"
          />
        </div>
      )}
      {wipe && <Handle slider={slider} />}
      {boxes}
      {wipe && (
        <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-between">
          <Pill>Main</Pill>
          <Pill>Branch</Pill>
        </div>
      )}
    </div>
  );
}

/** The toolbar's half of the slider: Main to Branch on a compact range, and the onion skin toggle. */
export function SliderControls({
  slider,
  branchUrl,
}: {
  slider: SliderState;
  branchUrl: string | null;
}) {
  const hydrated = useHydrated();
  const { position, onion, setPosition, setOnion } = slider;
  return (
    <>
      <label className="flex items-center gap-2">
        <Caption>Main</Caption>
        <input
          type="range"
          aria-label="Compare position"
          title={onion ? `Branch at ${position}% opacity` : `Main to ${position}%, Branch after`}
          min={0}
          max={100}
          value={position}
          disabled={!hydrated || !branchUrl}
          onChange={(e) => setPosition(Number(e.target.value))}
          className="w-32"
        />
        <Caption>Branch</Caption>
      </label>
      <ToggleChip
        pressed={onion}
        disabled={!hydrated}
        title="Fade Branch over Main instead of wiping"
        onClick={() => setOnion(!onion)}
      >
        Onion skin
      </ToggleChip>
    </>
  );
}

/** The frame is as tall as the main shot, so the boxes are drawn at the frame's scale. */
function FrameBoxes({ result, frameW }: { result: DiffResult | null; frameW: number }) {
  if (!result) return null;
  return <RegionBoxes width={frameW} height={result.mainHeight} regions={result.regions} />;
}

/**
 * A wipe between the two shots (or the branch faded over the main). Both render at one scale:
 * each width as a share of the wider frame, so the pixels line up. The range and onion toggle
 * are in the toolbar (`SliderControls`); the state is the viewer's.
 */
export function SnapshotSlider({
  name,
  mainUrl,
  branchUrl,
  result,
  highlight,
  scale,
  crop,
  slider,
}: {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  result: DiffResult | null;
  highlight: boolean;
  scale: Scale;
  crop: Crop | null;
  slider: SliderState;
}) {
  const mainW = result?.mainWidth ?? 0;
  const branchW = result?.branchWidth ?? 0;
  const frameW = Math.max(mainW, branchW);
  const share = (px: number) => (frameW ? `${(px / frameW) * 100}%` : "100%");
  return (
    <Viewport width={frameW || null} scale={scale} crop={crop}>
      <ShotLayers
        name={name}
        mainUrl={mainUrl}
        branchUrl={branchUrl}
        slider={slider}
        mains={share(mainW || 1)}
        branches={share(branchW || 1)}
        boxes={highlight && mainUrl ? <FrameBoxes result={result} frameW={frameW} /> : null}
      />
    </Viewport>
  );
}
