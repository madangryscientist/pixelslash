import type { ReactNode } from "react";
import type { Crop } from "../../../../packages/engine/src/report-crop.ts";
import type { DiffRegion } from "#/db/schema";

/** How big a shot is drawn: fitted to its pane, at its own pixels, or cropped to the change. */
export type Scale = "fit" | "actual" | "zoom";

export const REGION_COLOURS: Record<DiffRegion["kind"], string> = {
  change: "#dc2626",
  noise: "#d97706",
  shift: "#2563eb",
};

/**
 * The stored regions over an image `width`×`height` px. They are in the overlap's px, which starts
 * at the top-left of both shots, so the same boxes sit right on either one.
 */
export function RegionBoxes({
  width,
  height,
  regions,
}: {
  width: number;
  height: number;
  regions: DiffRegion[];
}) {
  return (
    <svg
      aria-label="Measured regions"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
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
          fill={REGION_COLOURS[region.kind]}
          fillOpacity={0.12}
          stroke={REGION_COLOURS[region.kind]}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
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

/** A crop is never blown up past this, so a three-pixel change does not fill the screen. */
const MAX_ZOOM = 6;

/**
 * A window onto something laid out at 100% width with the aspect of a `width` px wide image.
 * `zoom` shows only `crop`, by sizing and offsetting the content like the whole image inside a
 * window shaped like the crop (the report's crop maths, in CSS): nothing is re-rendered or stored.
 * Without a crop, `zoom` is `fit`.
 */
export function Viewport({
  width,
  scale,
  crop,
  children,
}: {
  /** The image's width in px; null when nothing measured it (a new or removed shot). */
  width: number | null;
  scale: Scale;
  crop: Crop | null;
  children: ReactNode;
}) {
  if (scale === "zoom" && crop && width) {
    return (
      <div
        data-scale="zoom"
        className="relative overflow-hidden"
        style={{ aspectRatio: `${crop.w} / ${crop.h}`, width: `min(100%, ${crop.w * MAX_ZOOM}px)` }}
      >
        <div
          className="absolute [&_img]:[image-rendering:pixelated]"
          style={{
            width: `${(width / crop.w) * 100}%`,
            left: `${(-crop.x / crop.w) * 100}%`,
            top: `${(-crop.y / crop.h) * 100}%`,
          }}
        >
          {children}
        </div>
      </div>
    );
  }
  if (scale === "actual") {
    return (
      <div data-scale="actual" className="max-h-[75vh] overflow-auto">
        <div
          className={width ? undefined : "w-max"}
          style={width ? { width: `${width}px` } : undefined}
        >
          {children}
        </div>
      </div>
    );
  }
  // A shot is fitted down to its pane, never stretched past its own pixels.
  return (
    <div
      data-scale="fit"
      className="max-w-full"
      style={width ? { width: `${width}px` } : { width: "fit-content" }}
    >
      {children}
    </div>
  );
}
