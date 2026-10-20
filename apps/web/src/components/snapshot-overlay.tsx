import { useState } from "react";
import { useHydrated } from "#/components/ui";
import type { DiffRegion, DiffResult } from "#/db/schema";

const COLOURS: Record<DiffRegion["kind"], string> = {
  change: "#dc2626",
  noise: "#d97706",
  shift: "#2563eb",
};

const KINDS = ["change", "noise", "shift"] as const;

function RegionBoxes({ result, regions }: { result: DiffResult; regions: DiffRegion[] }) {
  return (
    <svg
      aria-label="Measured regions"
      role="img"
      viewBox={`0 0 ${result.branchWidth} ${result.branchHeight}`}
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {regions.map((region, i) => (
        <rect
          // Regions come from one measurement of this image: the index is a stable key.
          key={i}
          data-kind={region.kind}
          x={region.x}
          y={region.y}
          width={region.w}
          height={region.h}
          fill={COLOURS[region.kind]}
          fillOpacity={0.12}
          stroke={COLOURS[region.kind]}
          strokeWidth={2}
        >
          <title>
            {region.kind}: {region.changedPixels} px
            {region.why ? ` · ${region.why}` : ""}
          </title>
        </rect>
      ))}
    </svg>
  );
}

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
  const width = boxes ? { width: `${boxes.result.branchWidth}px`, maxWidth: "100%" } : undefined;
  return (
    <div className="relative" style={width}>
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
      {boxes && <RegionBoxes result={boxes.result} regions={boxes.regions} />}
    </div>
  );
}

function Controls({
  regions,
  compare,
  diffUrl,
  showDiff,
  onShowDiff,
}: {
  regions: DiffRegion[];
  compare: string | null;
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
      <ul className="flex flex-wrap gap-3 text-neutral-600">
        {KINDS.map((kind) => {
          const n = regions.filter((region) => region.kind === kind).length;
          if (n === 0) return null;
          return (
            <li key={kind} className="flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block size-3 rounded-sm"
                style={{ background: COLOURS[kind] }}
              />
              {kind} ({n})
            </li>
          );
        })}
      </ul>
      {compare && <span className="text-neutral-500">compared at {compare}</span>}
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
}: {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  diffUrl: string | null;
  result: DiffResult | null;
}) {
  const [showDiff, setShowDiff] = useState(true);
  const regions = result?.regions ?? [];
  // Boxes belong to the comparison, so they are drawn only when there was one.
  const boxes = result && branchUrl ? { result, regions } : null;
  const compare = result ? `${result.width}×${result.height}` : null;
  return (
    <div>
      <div className="rounded-lg border border-neutral-200 bg-white p-3">
        <Stack
          name={name}
          shown={branchUrl ?? mainUrl}
          diffUrl={diffUrl}
          showDiff={showDiff}
          boxes={boxes}
        />
      </div>
      <Controls
        regions={regions}
        compare={compare}
        diffUrl={diffUrl}
        showDiff={showDiff}
        onShowDiff={setShowDiff}
      />
    </div>
  );
}
