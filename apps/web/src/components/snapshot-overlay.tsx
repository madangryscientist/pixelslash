import {
  Caption,
  Card,
  Checkbox,
  Cluster,
  Legend,
  type LegendItem,
  Stack,
} from "@hackcove/ui-react";
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

/** The top layer's opacity, 0 to 100: held by the viewer so the toolbar's range and the image share it. */
export type OverlayState = { opacity: number; setOpacity: (opacity: number) => void };

export function useOverlay(): OverlayState {
  const [opacity, setOpacity] = useState(50);
  return { opacity, setOpacity };
}

/** The toolbar's half of the overlay: how strongly the top layer (the diff image) covers Branch. */
export function OverlayControls({
  overlay,
  diffUrl,
}: {
  overlay: OverlayState;
  diffUrl: string | null;
}) {
  const hydrated = useHydrated();
  return (
    <label className="flex items-center gap-2">
      <Caption>Opacity</Caption>
      <input
        type="range"
        aria-label="Overlay opacity"
        title={`Top layer at ${overlay.opacity}% opacity`}
        min={0}
        max={100}
        value={overlay.opacity}
        disabled={!hydrated || !diffUrl}
        onChange={(e) => overlay.setOpacity(Number(e.target.value))}
        className="w-32"
      />
      <Caption numeric>{overlay.opacity}%</Caption>
    </label>
  );
}

function ShotStack({
  name,
  shown,
  diffUrl,
  showDiff,
  opacity,
  boxes,
}: {
  name: string;
  shown: string | null;
  diffUrl: string | null;
  showDiff: boolean;
  opacity: number;
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
          data-testid="overlay-top"
          className="pointer-events-none absolute inset-0 w-full"
          style={{ opacity: opacity / 100 }}
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
  overlay,
}: {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  diffUrl: string | null;
  result: DiffResult | null;
  highlight: boolean;
  scale: Scale;
  crop: Crop | null;
  overlay: OverlayState;
}) {
  const [showDiff, setShowDiff] = useState(true);
  const regions = result?.regions ?? [];
  // Boxes belong to the comparison, so they are drawn only when there was one.
  const boxes = result && branchUrl && highlight ? { result, regions } : null;
  return (
    <Stack gap="xs">
      <Viewport width={result?.branchWidth ?? null} scale={scale} crop={crop}>
        <Card as="div" flush>
          <ShotStack
            name={name}
            shown={branchUrl ?? mainUrl}
            diffUrl={diffUrl}
            showDiff={showDiff}
            opacity={overlay.opacity}
            boxes={boxes}
          />
        </Card>
      </Viewport>
      <Controls regions={regions} diffUrl={diffUrl} showDiff={showDiff} onShowDiff={setShowDiff} />
    </Stack>
  );
}
