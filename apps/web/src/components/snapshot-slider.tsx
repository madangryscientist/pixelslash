import { type ReactNode, useState } from "react";
import type { Crop } from "../../../../packages/engine/src/report-crop.ts";
import { RegionBoxes, type Scale, Viewport } from "#/components/snapshot-frame";
import { useHydrated } from "#/components/ui";
import type { DiffResult } from "#/db/schema";

function Stack({
  name,
  mainUrl,
  branchUrl,
  position,
  onion,
  mains,
  branches,
  boxes,
}: {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  position: number;
  onion: boolean;
  mains: string;
  branches: string;
  boxes: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden border border-slate-200 bg-white">
      {mainUrl ? (
        <img src={mainUrl} alt={`${name} on main`} className="block" style={{ width: mains }} />
      ) : (
        <div style={{ paddingBottom: "40%" }} />
      )}
      {branchUrl && (
        <div
          className="absolute inset-0"
          style={
            onion ? { opacity: position / 100 } : { overflow: "hidden", width: `${position}%` }
          }
        >
          <img
            src={branchUrl}
            alt={`${name} on the branch`}
            className="absolute top-0 left-0 w-auto max-w-none"
            style={{ width: branches }}
          />
        </div>
      )}
      {!onion && (
        <div
          aria-hidden
          className="absolute inset-y-0 w-0.5 bg-violet-600"
          style={{ left: `${position}%` }}
        />
      )}
      {boxes}
    </div>
  );
}

function Controls({
  position,
  onion,
  branchUrl,
  onPosition,
  onOnion,
}: {
  position: number;
  onion: boolean;
  branchUrl: string | null;
  onPosition: (position: number) => void;
  onOnion: (onion: boolean) => void;
}) {
  const hydrated = useHydrated();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
      <input
        type="range"
        aria-label="Compare position"
        min={0}
        max={100}
        value={position}
        disabled={!hydrated || !branchUrl}
        onChange={(e) => onPosition(Number(e.target.value))}
        className="w-64"
      />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={onion}
          disabled={!hydrated}
          onChange={(e) => onOnion(e.target.checked)}
        />
        Onion skin
      </label>
      <span className="text-slate-500">
        {onion ? `branch at ${position}% opacity` : `branch from ${position}%`}
      </span>
    </div>
  );
}

/** The frame is as tall as the main shot, so the boxes are drawn at the frame's scale. */
function FrameBoxes({ result, frameW }: { result: DiffResult | null; frameW: number }) {
  if (!result) return null;
  return <RegionBoxes width={frameW} height={result.mainHeight} regions={result.regions} />;
}

/**
 * A wipe between the two shots (or the branch faded over the main). Both render at one scale:
 * each width as a share of the wider frame, so the pixels line up.
 */
export function SnapshotSlider({
  name,
  mainUrl,
  branchUrl,
  result,
  highlight,
  scale,
  crop,
}: {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  result: DiffResult | null;
  highlight: boolean;
  scale: Scale;
  crop: Crop | null;
}) {
  const [position, setPosition] = useState(50);
  const [onion, setOnion] = useState(false);
  const mainW = result?.mainWidth ?? 0;
  const branchW = result?.branchWidth ?? 0;
  const frameW = Math.max(mainW, branchW);
  const share = (px: number) => (frameW ? `${(px / frameW) * 100}%` : "100%");
  return (
    <div>
      <Viewport width={frameW || null} scale={scale} crop={crop}>
        <Stack
          name={name}
          mainUrl={mainUrl}
          branchUrl={branchUrl}
          position={position}
          onion={onion}
          mains={share(mainW || 1)}
          branches={share(branchW || 1)}
          boxes={highlight && mainUrl ? <FrameBoxes result={result} frameW={frameW} /> : null}
        />
      </Viewport>
      <Controls
        position={position}
        onion={onion}
        branchUrl={branchUrl}
        onPosition={setPosition}
        onOnion={setOnion}
      />
    </div>
  );
}
