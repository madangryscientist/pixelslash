import { Checkbox, Cluster, Legend, type LegendItem, Stack } from "@hackcove/ui";
import { useState } from "react";
import type { Crop } from "../../../../packages/engine/src/report-crop.ts";
import { RegionBoxes, type Scale, Viewport } from "#/components/snapshot-frame";
import { useHydrated } from "#/components/ui";
import type { DiffRegion, DiffResult } from "#/db/schema";

/** The swatch tone nearest each kind's box colour in REGION_COLOURS. */
const KINDS = [
  { kind: "change", tone: "danger" },
  { kind: "noise", tone: "warn" },
  { kind: "shift", tone: "info" },
] as const;

function ShotStack({
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
  const items: LegendItem[] = KINDS.flatMap(({ kind, tone }) => {
    const n = regions.filter((region) => region.kind === kind).length;
    return n === 0 ? [] : [{ label: kind, tone, detail: n }];
  });
  return (
    <Cluster gap="sm" wrap>
      <Checkbox
        label="Diff image"
        size="sm"
        checked={showDiff}
        disabled={!hydrated || !diffUrl}
        onChange={(e) => onShowDiff(e.target.checked)}
      />
      <Legend items={items} />
    </Cluster>
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
    <Stack gap="xs">
      <Viewport width={result?.branchWidth ?? null} scale={scale} crop={crop}>
        <div className="border border-slate-200">
          <ShotStack
            name={name}
            shown={branchUrl ?? mainUrl}
            diffUrl={diffUrl}
            showDiff={showDiff}
            boxes={boxes}
          />
        </div>
      </Viewport>
      <Controls regions={regions} diffUrl={diffUrl} showDiff={showDiff} onShowDiff={setShowDiff} />
    </Stack>
  );
}
