import { Button } from "@hackcove/ui";
import { useState } from "react";
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

function size(width: number | undefined, height: number | undefined): string | null {
  return width && height ? `${width}×${height}` : null;
}

function ModeButtons({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const hydrated = useHydrated();
  return (
    <div role="group" aria-label="View mode" className="mb-3 flex gap-1">
      {MODES.map(({ id, label }) => (
        <Button
          key={id}
          variant={mode === id ? "primary" : "outline"}
          aria-pressed={mode === id}
          disabled={!hydrated}
          onClick={() => onChange(id)}
          className="px-3 py-1.5"
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function Panel({
  label,
  caption,
  url,
  alt,
  empty,
}: {
  label: string;
  caption: string | null;
  url: string | null;
  alt: string;
  empty: string;
}) {
  return (
    <figure className="rounded-lg border border-slate-200 bg-white p-3">
      <figcaption className="mb-2 text-sm font-medium">
        {label}
        {caption && <span className="ml-2 font-normal text-slate-500">{caption}</span>}
      </figcaption>
      {url ? (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          className="block max-w-full border border-slate-100"
        />
      ) : (
        <p className="py-8 text-center text-sm text-slate-500">{empty}</p>
      )}
    </figure>
  );
}

function SideBySide({
  name,
  mainUrl,
  branchUrl,
  result,
  removed,
}: {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  result: DiffResult | null;
  removed: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Panel
        label="Main (baseline)"
        caption={size(result?.mainWidth, result?.mainHeight)}
        url={mainUrl}
        alt={`${name} on main`}
        empty="No baseline to compare with."
      />
      <Panel
        label="Branch"
        caption={size(result?.branchWidth, result?.branchHeight)}
        url={branchUrl}
        alt={`${name} on the branch`}
        empty={removed ? "The branch no longer has this shot." : "This shot has no branch image."}
      />
    </div>
  );
}

/**
 * The three ways to look at one shot. Boxes are drawn from the regions the diff stored, nothing
 * is recomputed here; when the two shots differ in size only the measured overlap carries boxes.
 */
export function SnapshotViewer({
  name,
  mainUrl,
  branchUrl,
  diffUrl,
  result,
  removed,
}: {
  name: string;
  mainUrl: string | null;
  branchUrl: string | null;
  diffUrl: string | null;
  result: DiffResult | null;
  removed: boolean;
}) {
  const [mode, setMode] = useState<Mode>("side");
  return (
    <section aria-label="Snapshot viewer">
      <ModeButtons mode={mode} onChange={setMode} />
      {mode === "side" && (
        <SideBySide
          name={name}
          mainUrl={mainUrl}
          branchUrl={branchUrl}
          result={result}
          removed={removed}
        />
      )}
      {mode === "overlay" && (
        <SnapshotOverlay
          name={name}
          mainUrl={mainUrl}
          branchUrl={branchUrl}
          diffUrl={diffUrl}
          result={result}
        />
      )}
      {mode === "slider" && (
        <SnapshotSlider name={name} mainUrl={mainUrl} branchUrl={branchUrl} result={result} />
      )}
    </section>
  );
}
