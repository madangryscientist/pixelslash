import { type ReactNode, type SyntheticEvent, useCallback, useState } from "react";
import type { Crop } from "../../../../packages/engine/src/report-crop.ts";
import { type Composition, CompositionBoxes } from "#/components/composition";
import {
  DrawLayer,
  FlagMarks,
  type IgnoreArea,
  IgnoreAreas,
  RegionBoxes,
  type Scale,
  Viewport,
} from "#/components/snapshot-frame";
import type { DiffResult, IgnoreRect } from "#/db/schema";

/**
 * Flagged and ignored areas to show, and while one is being drawn, where it goes. Side by side only.
 */
export type Marking = {
  marks: IgnoreRect[];
  onDraw: ((rect: IgnoreRect) => void) | null;
  ignored: IgnoreArea[];
};

type Size = { width: number; height: number };

/** An image's own size once it has loaded; a shot nothing measured is still drawn on at this size. */
function useNaturalSize(url: string) {
  const [loaded, setLoaded] = useState<(Size & { url: string }) | null>(null);
  const read = useCallback(
    (img: HTMLImageElement | null) => {
      if (img?.complete && img.naturalWidth > 0)
        setLoaded({ url, width: img.naturalWidth, height: img.naturalHeight });
    },
    [url],
  );
  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => read(e.currentTarget);
  // Another shot's size is not this one's.
  const size = loaded && loaded.url === url ? loaded : null;
  return [size, read, onLoad] as const;
}

/**
 * The ignored areas and flagged areas on a shot, and the layer that draws a new one while drawing
 * is on.
 */
function Marked({
  width,
  height,
  marks,
  onDraw,
  ignored,
}: { width: number; height: number } & Marking) {
  return (
    <>
      {ignored.length > 0 && <IgnoreAreas width={width} height={height} areas={ignored} />}
      {marks.length > 0 && <FlagMarks width={width} height={height} marks={marks} />}
      {onDraw && <DrawLayer width={width} height={height} onDraw={onDraw} />}
    </>
  );
}

/** The shot with what is drawn over it; `children` is told the image's own size once it is known. */
function ShotImage({
  url,
  alt,
  children,
}: {
  url: string;
  alt: string;
  children: (natural: Size | null) => ReactNode;
}) {
  const [size, attach, onLoad] = useNaturalSize(url);
  return (
    <div className="relative border border-slate-200">
      <img
        ref={attach}
        onLoad={onLoad}
        src={url}
        alt={alt}
        loading="lazy"
        className="block w-full"
      />
      {children(size)}
    </div>
  );
}

/** The findings, placed on the measured size, or on the image's own for a shot nothing measured. */
function Findings({
  composition,
  width,
  height,
  natural,
}: {
  composition: Composition | null | undefined;
  width: number | null;
  height: number | null;
  natural: Size | null;
}) {
  const w = width ?? natural?.width;
  const h = height ?? natural?.height;
  if (!composition || !w || !h) return null;
  return <CompositionBoxes width={w} height={h} composition={composition} />;
}

export function Pane({
  label,
  caption,
  url,
  alt,
  empty,
  width,
  height,
  boxes,
  scale,
  crop,
  marks,
  onDraw,
  ignored,
  composition,
}: {
  label: string;
  caption: string | null;
  url: string | null;
  alt: string;
  empty: string;
  width: number | null;
  height: number | null;
  boxes: DiffResult["regions"] | null;
  scale: Scale;
  crop: Crop | null;
  composition?: Composition | null | undefined;
} & Marking) {
  const measured = width && height ? { width, height } : null;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm font-medium">
        {label}
        {caption && <span className="ml-2 font-normal text-slate-500">{caption}</span>}
      </figcaption>
      {url ? (
        <Viewport width={width} scale={scale} crop={crop}>
          <ShotImage url={url} alt={alt}>
            {(natural) => (
              <>
                {boxes && measured && <RegionBoxes {...measured} regions={boxes} />}
                <Findings composition={composition} {...{ width, height, natural }} />
                {measured && <Marked {...measured} {...{ marks, onDraw, ignored }} />}
              </>
            )}
          </ShotImage>
        </Viewport>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 py-8 text-center text-sm text-slate-500">
          {empty}
        </p>
      )}
    </figure>
  );
}
