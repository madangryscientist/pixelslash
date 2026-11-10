import type { CSSProperties, ReactNode } from "react";
import hero from "#/content/hero.json";

// The homepage's hero demo (pages/home.tsx).

/** A style with CSS custom properties, which CSSProperties does not list. */
function vars(style: CSSProperties & Record<`--${string}`, number | string>): CSSProperties {
  return style;
}

const CHANGES = hero.regions.filter((region) => region.kind === "change");
const pct = (value: number, of: number): string => `${(value / of) * 100}%`;

/** Shot pixels of room kept around the change regions in the phone crop. */
const CROP_MARGIN = 32;

/**
 * The part of the shot a phone frames: the union of the change regions plus a margin, grown about its
 * centre to the shot's aspect ratio, then shifted (never shrunk) to lie inside the shot. If it
 * would not fit, the whole shot.
 */
function cropOf(regions: readonly { x: number; y: number; w: number; h: number }[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const whole = { x: 0, y: 0, w: hero.width, h: hero.height };
  if (regions.length === 0) return whole;
  const left = Math.min(...regions.map((region) => region.x)) - CROP_MARGIN;
  const top = Math.min(...regions.map((region) => region.y)) - CROP_MARGIN;
  const right = Math.max(...regions.map((region) => region.x + region.w)) + CROP_MARGIN;
  const bottom = Math.max(...regions.map((region) => region.y + region.h)) + CROP_MARGIN;
  const ratio = hero.width / hero.height;
  const w = Math.max(right - left, (bottom - top) * ratio);
  const h = w / ratio;
  if (w >= hero.width || h >= hero.height) return whole;
  const x = Math.min(Math.max((left + right) / 2 - w / 2, 0), hero.width - w);
  const y = Math.min(Math.max((top + bottom) / 2 - h / 2, 0), hero.height - h);
  return { x, y, w, h };
}

const CROP = cropOf(CHANGES);

/** Main, wiped into Branch by the slash; the boxes are where the run found its regions. */
export function Demo(): ReactNode {
  return (
    <figure className="home-demo-wrap mx-auto mt-12 max-w-5xl">
      <div className="home-window">
        <div className="home-window-bar">
          <span />
          <span />
          <span />
          <p>northwind.test/billing</p>
        </div>
        <div
          className="home-demo"
          style={vars({
            aspectRatio: `${hero.width} / ${hero.height}`,
            "--shot-w": hero.width,
            "--shot-h": hero.height,
            "--crop-x": CROP.x,
            "--crop-y": CROP.y,
            "--crop-w": CROP.w,
            "--crop-h": CROP.h,
          })}
        >
          <div className="home-stage">
            <img src="/hero/main.png" alt="" width={hero.width} height={hero.height} />
            <div className="home-demo-branch">
              <img src="/hero/branch.png" alt="" width={hero.width} height={hero.height} />
              {CHANGES.map((region, index) => (
                <span
                  key={`${region.x},${region.y}`}
                  className="home-region"
                  style={vars({
                    left: pct(region.x, hero.width),
                    top: pct(region.y, hero.height),
                    width: pct(region.w, hero.width),
                    height: pct(region.h, hero.height),
                    "--i": index,
                  })}
                />
              ))}
            </div>
            <div className="home-slash" aria-hidden="true" />
          </div>
          <span className="home-chip home-chip-main">Main</span>
          <span className="home-chip home-chip-branch">Branch</span>
        </div>
      </div>
      <div className="home-readout" aria-hidden="true">
        <span className="home-count" style={vars({ "--to": hero.changedPixels })} />
        <span>changed pixels</span>
        <span className="home-dot" />
        <span>{CHANGES.length} regions</span>
      </div>
      <figcaption className="mx-auto mt-4 max-w-2xl text-center text-sm text-(--home-sub)">
        A real run, not a mock-up:{" "}
        <code className="whitespace-nowrap">pixelslash --live --local</code> on a billing page at{" "}
        {hero.width}×{hero.height}. It found {hero.changedPixels} changed pixels in {CHANGES.length}{" "}
        regions: the price, the button, the storage bar and its label.
      </figcaption>
    </figure>
  );
}
