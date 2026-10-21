import { useState } from "react";
import type { Crop } from "../../../../packages/engine/src/report-crop.ts";
import { REGION_COLOURS, RegionBoxes, type Scale, Viewport } from "#/components/snapshot-frame";
import { useHydrated } from "#/components/ui";
import type { DiffRegion, DiffResult } from "#/db/schema";

const KINDS = ["change", "noise", "shift"] as const;

function Stack({
  name,
  shown,
  diffUrl,
  showDiff,
  boxes,
}: {
  name: string;
  shown: string | null;
  diffUrl: string | null;
  showDiff: boolean;
  boxes: { result: DiffResult; regions: DiffRegion[] } | null;
}) {
  return (
    <div className="relative">
      {shown ? (
        <img src={shown} alt={`${name} with measured regions`} className="block w-full" />
      ) : (
        <p className="py-16 text-center text-sm">No image to show.</p>
      )}
      {diffUrl && showDiff && (
        <img
          src={diffUrl}
          alt=""
          className="pointer-events-none absolute inset-0 w-full"
          style={{ opacity: 0.85 }}
        />
      )}
      {boxes && (
        <RegionBoxes
          width={boxes.result.branchWidth}
          height={boxes.result.branchHeight}
          regions={boxes.regions}
        />
      )}
    </div>
  );
}

function Controls({
  regions,
  diffUrl,
  showDiff,
  onShowDiff,
}: {
  regions: DiffRegion[];
  diffUrl: string | null;
  showDiff: boolean;
  onShowDiff: (show: boolean) => void;
}) {
  const hydrated = useHydrated();
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={showDiff}
          disabled={!hydrated || !diffUrl}
          onChange={(e) => onShowDiff(e.target.checked)}
        />
        Diff image
      </label>
      <ul className="flex flex-wrap gap-3 text-slate-600">
        {KINDS.map((kind) => {
          const n = regions.filter((region) => region.kind === kind).length;
          if (n === 0) return null;
          return (
            <li key={kind} className="flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block size-3 rounded-sm"
                style={{ background: REGION_COLOURS[kind] }}
              />
              {kind} ({n})
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Branch image, the stored diff image and the measured boxes, all on the same pixel grid. */
export function SnapshotOverlay({
  name,
  mainUrl,
  branchUrl,
  diffUrl,
  result,
  highlight,
  scale,
  crop,
}: {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  diffUrl: string | null;
  result: DiffResult | null;
  highlight: boolean;
  scale: Scale;
  crop: Crop | null;
}) {
  const [showDiff, setShowDiff] = useState(true);
  const regions = result?.regions ?? [];
  // Boxes belong to the comparison, so they are drawn only when there was one.
  const boxes = result && branchUrl && highlight ? { result, regions } : null;
  return (
    <div>
      <Viewport width={result?.branchWidth ?? null} scale={scale} crop={crop}>
        <div className="border border-slate-200">
          <Stack
            name={name}
            shown={branchUrl ?? mainUrl}
            diffUrl={diffUrl}
            showDiff={showDiff}
            boxes={boxes}
          />
        </div>
      </Viewport>
      <Controls regions={regions} diffUrl={diffUrl} showDiff={showDiff} onShowDiff={setShowDiff} />
    </div>
  );
}
