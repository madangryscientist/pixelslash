import { KeyValue } from "@hackcove/ui";
import type { SnapshotView } from "#/db/review";
import { formatDuration } from "#/lib/format";
import { compareMsOf } from "#/lib/run-metrics";

const MEASURED_BY = { ci: "CI (the CLI)", server: "PixelSlash server" } as const;

/** Where the diff ran and on which engine (ob 1727); nothing for a shot measured before it was recorded. */
export function Provenance({ snapshot }: { snapshot: SnapshotView }) {
  if (!snapshot.measuredBy) return null;
  return (
    <>
      <KeyValue label="Measured by">
        <span data-testid="measured-by">{MEASURED_BY[snapshot.measuredBy]}</span>
      </KeyValue>
      <KeyValue label="Engine">{snapshot.engineVersion ?? "unknown"}</KeyValue>
      <CompareTime snapshot={snapshot} />
    </>
  );
}

/** How long the server took to compare it (PS-233), when it stored that; nothing otherwise. */
function CompareTime({ snapshot }: { snapshot: SnapshotView }) {
  const ms = compareMsOf(snapshot);
  if (ms === null) return null;
  return (
    <KeyValue label="Compare time">
      <span data-testid="compare-time">{formatDuration(ms)}</span>
    </KeyValue>
  );
}
