import {
  MAX_FINDINGS,
  type Composition,
  type Gap,
  type SpecialCase,
} from "@pixelslash/engine/composition-entry";

export type { Composition };

/**
 * A composition-only project's findings on one shot (ob 1850): the elements styled outside the
 * library ("gaps") and the ones declared custom ("special cases"). Measured from the branch's DOM at
 * capture; nothing here is recomputed.
 */

type Rect = { x: number; y: number; width: number; height: number };

const place = (r: Rect, width: number, height: number) => ({
  left: `${(r.x / width) * 100}%`,
  top: `${(r.y / height) * 100}%`,
  width: `${(r.width / width) * 100}%`,
  height: `${(r.height / height) * 100}%`,
});

/** What a gap adds that the library does not give. */
export function gapWhat(gap: Gap): string {
  const parts = [
    gap.classes.length > 0 ? `class ${gap.classes.join(" ")}` : null,
    gap.style ? `style ${gap.style}` : null,
  ];
  return parts.filter(Boolean).join("; ");
}

const KIND: Record<Gap["kind"], string> = {
  element: "styled element with no library root",
  class: "classes the library does not give",
  style: "inline style",
};

/** The findings' boxes over the branch image `width`×`height` px: gaps in amber, special cases in violet. */
export function CompositionBoxes({
  width,
  height,
  composition,
}: {
  width: number;
  height: number;
  composition: Composition;
}) {
  return (
    <div aria-label="Composition findings" className="pointer-events-none absolute inset-0">
      {composition.gaps.map((gap, i) => (
        <div
          // Findings are stored in walk order: the index is a stable key.
          key={`g${i}`}
          data-testid="gap-box"
          title={`${gap.selector}: ${gapWhat(gap)}`}
          className="absolute border-2 border-amber-500 bg-amber-400/15"
          style={place(gap.box, width, height)}
        />
      ))}
      {composition.special.map((s, i) => (
        <div
          key={`s${i}`}
          data-testid="special-box"
          title={`${s.selector}: ${s.reason}`}
          className="absolute border-2 border-dashed border-violet-500 bg-violet-400/10"
          style={place(s.box, width, height)}
        />
      ))}
    </div>
  );
}

function GapItem({ gap }: { gap: Gap }) {
  return (
    <li className="py-1.5">
      <code className="text-xs break-all">{gap.selector}</code>
      <p className="text-sm">
        {KIND[gap.kind]}: <code className="text-xs break-all">{gapWhat(gap)}</code>
      </p>
    </li>
  );
}

function SpecialItem({ special }: { special: SpecialCase }) {
  return (
    <li className="py-1.5">
      <code className="text-xs break-all">{special.selector}</code>
      <p className="text-sm">{special.reason}</p>
    </li>
  );
}

/** The two lists under the shot; nothing for a project that is not composition-only. */
export function CompositionPanel({ composition }: { composition: Composition | null }) {
  if (!composition) return null;
  const { library, gaps, special, omitted } = composition;
  return (
    <section aria-label="Composition" className="grid gap-4 sm:grid-cols-2">
      {omitted ? (
        <p className="text-sm text-slate-500 sm:col-span-2">
          {omitted} more past the cap of {MAX_FINDINGS} a shot were not kept.
        </p>
      ) : null}
      <div>
        <h2 className="text-sm font-semibold">
          {library} gaps ({gaps.length})
        </h2>
        {gaps.length === 0 ? (
          <p className="text-sm text-slate-500">Everything styled here comes from {library}.</p>
        ) : (
          <ul aria-label={`${library} gaps`} className="divide-y divide-slate-200">
            {gaps.map((gap, i) => (
              // Walk order, fixed for one page load.
              <GapItem key={i} gap={gap} />
            ))}
          </ul>
        )}
      </div>
      <div>
        <h2 className="text-sm font-semibold">Special cases ({special.length})</h2>
        {special.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing on this shot is declared custom.</p>
        ) : (
          <ul aria-label="Special cases" className="divide-y divide-slate-200">
            {special.map((s, i) => (
              <SpecialItem key={i} special={s} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
