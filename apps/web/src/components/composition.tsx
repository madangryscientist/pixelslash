import {
  createContext,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Caption, Stack, SubsectionHeading, Text } from "@hackcove/ui";
import {
  GAP_COLOUR,
  MAX_FINDINGS,
  SPECIAL_COLOUR,
  gapReason,
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

/** One finding, as a box and its list row know each other by. */
type Finding = { kind: "gap" | "special"; index: number };

const FocusContext = createContext<{
  focus: Finding | null;
  setFocus: (f: Finding | null) => void;
}>({ focus: null, setFocus: () => {} });

/** Shares the finding under the pointer between the boxes on the shot and the rows under it. */
export function CompositionFocus({ children }: { children: ReactNode }) {
  const [focus, setFocus] = useState<Finding | null>(null);
  const value = useMemo(() => ({ focus, setFocus }), [focus]);
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

const isFocused = (focus: Finding | null, kind: Finding["kind"], index: number) =>
  focus?.kind === kind && focus.index === index;

/** Hex colour `hex` at `alpha` (0-255) as an 8-digit hex. */
const tint = (hex: string, alpha: number) => `${hex}${alpha.toString(16).padStart(2, "0")}`;

const swatch = (colour: string, dashed: boolean): CSSProperties => ({
  borderColor: colour,
  borderStyle: dashed ? "dashed" : "solid",
  backgroundColor: tint(colour, 0x30),
});

/** The legend for the boxes: what each colour is, with how many on this shot. */
export function CompositionLegend({ composition }: { composition: Composition }) {
  const { library, gaps, special } = composition;
  return (
    <ul aria-label="Composition legend" className="flex flex-wrap items-center gap-3 text-xs">
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-3 border-2" style={swatch(GAP_COLOUR, false)} />
        Not from {library} ({gaps.length})
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-3 border-2" style={swatch(SPECIAL_COLOUR, true)} />
        Special case ({special.length})
      </li>
    </ul>
  );
}

/** The findings' boxes over the branch image `width`×`height` px: gaps in amber, special cases dashed in violet. */
export function CompositionBoxes({
  width,
  height,
  composition,
}: {
  width: number;
  height: number;
  composition: Composition;
}) {
  const { focus, setFocus } = useContext(FocusContext);
  const box = (
    kind: Finding["kind"],
    i: number,
    colour: string,
    dashed: boolean,
  ): CSSProperties => ({
    borderColor: colour,
    borderStyle: dashed ? "dashed" : "solid",
    backgroundColor: tint(colour, isFocused(focus, kind, i) ? 0x66 : 0x1f),
    zIndex: isFocused(focus, kind, i) ? 1 : undefined,
  });
  return (
    <div aria-label="Composition findings" className="pointer-events-none absolute inset-0">
      {composition.gaps.map((gap, i) => (
        <div
          // Findings are stored in walk order: the index is a stable key.
          key={`g${i}`}
          data-testid="gap-box"
          title={`${gap.selector}: ${gapReason(gap, composition.library)}`}
          className="pointer-events-auto absolute border-2"
          style={{ ...place(gap.box, width, height), ...box("gap", i, GAP_COLOUR, false) }}
          onMouseEnter={() => setFocus({ kind: "gap", index: i })}
          onMouseLeave={() => setFocus(null)}
        />
      ))}
      {composition.special.map((s, i) => (
        <div
          key={`s${i}`}
          data-testid="special-box"
          title={`${s.selector}: ${s.reason}`}
          className="pointer-events-auto absolute border-2"
          style={{ ...place(s.box, width, height), ...box("special", i, SPECIAL_COLOUR, true) }}
          onMouseEnter={() => setFocus({ kind: "special", index: i })}
          onMouseLeave={() => setFocus(null)}
        />
      ))}
    </div>
  );
}

function Row({ finding, children }: { finding: Finding; children: ReactNode }) {
  const { focus, setFocus } = useContext(FocusContext);
  return (
    <li
      data-focused={isFocused(focus, finding.kind, finding.index) || undefined}
      className="py-1.5 data-[focused]:bg-slate-100"
      onMouseEnter={() => setFocus(finding)}
      onMouseLeave={() => setFocus(null)}
    >
      {children}
    </li>
  );
}

function GapItem({ gap, index, library }: { gap: Gap; index: number; library: string }) {
  return (
    <Row finding={{ kind: "gap", index }}>
      <Caption as="code" mono>
        {gap.selector}
      </Caption>
      <Text as="p">{gapReason(gap, library)}</Text>
    </Row>
  );
}

function SpecialItem({ special, index }: { special: SpecialCase; index: number }) {
  return (
    <Row finding={{ kind: "special", index }}>
      <Caption as="code" mono>
        {special.selector}
      </Caption>
      <Text as="p">{special.reason}</Text>
    </Row>
  );
}

/**
 * The two lists under the shot, full width: they describe Branch, and a column under Main would
 * read as Main's. Nothing for a project that is not composition-only.
 */
export function CompositionPanel({ composition }: { composition: Composition | null }) {
  if (!composition) return null;
  const { library, gaps, special, omitted } = composition;
  return (
    <Stack as="section" gap="sm" aria-label="Composition">
      {omitted ? (
        <Text as="p" tone="muted">
          {omitted} more past the cap of {MAX_FINDINGS} a shot were not kept.
        </Text>
      ) : null}
      <div>
        <SubsectionHeading as="h2" size="sm">
          {library} gaps on Branch ({gaps.length})
        </SubsectionHeading>
        {gaps.length === 0 ? (
          <Text as="p" tone="muted">
            Everything styled here comes from {library}.
          </Text>
        ) : (
          <ul aria-label={`${library} gaps`} className="divide-y divide-slate-200">
            {gaps.map((gap, i) => (
              // Walk order, fixed for one page load.
              <GapItem key={i} gap={gap} index={i} library={library} />
            ))}
          </ul>
        )}
      </div>
      <div>
        <SubsectionHeading as="h2" size="sm">
          Special cases on Branch ({special.length})
        </SubsectionHeading>
        {special.length === 0 ? (
          <Text as="p" tone="muted">
            Nothing on this shot is declared custom.
          </Text>
        ) : (
          <ul aria-label="Special cases" className="divide-y divide-slate-200">
            {special.map((s, i) => (
              <SpecialItem key={i} special={s} index={i} />
            ))}
          </ul>
        )}
      </div>
    </Stack>
  );
}
