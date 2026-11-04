import { Caption, Disclosure, Stack, Text } from "@hackcove/ui-react";
import type { Metrics, MetricsPart } from "@hackcove/pixelslash-engine/metrics-entry";

/**
 * A shot's layout metrics (PS-294, `docs/metrics.md`) as a compact per-part list in the side panel (a table's columns do not fit the panel's width):
 * what each named part measured and was styled with. Shown when the shot came with a metrics file and
 * not at all otherwise. The values are the file's, in logical px; nothing here compares two files.
 */

const n = (v: number) => String(v);

const boxText = (p: MetricsPart) => `${n(p.box.x)}, ${n(p.box.y)} · ${n(p.box.w)}×${n(p.box.h)}`;

const paddingText = (p: MetricsPart) => {
  const s = p.padding;
  if (!s) return null;
  return [s.top, s.right, s.bottom, s.left].map(n).join(" ");
};

const fontText = (p: MetricsPart) => {
  const f = p.font;
  if (!f) return null;
  return `${n(f.size)}/${f.lineHeight === undefined ? "normal" : n(f.lineHeight)} · ${n(f.weight)}`;
};

/** A colour value with a swatch in its own hex: the only colour on the table that is not the theme's. */
function Swatch({ label, hex }: { label: string; hex: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" data-testid="metrics-colour">
      <span
        aria-hidden="true"
        className="inline-block size-3 rounded-sm border border-current opacity-90"
        style={{ backgroundColor: hex }}
      />
      <Caption as="span" mono>
        {label} {hex}
      </Caption>
    </span>
  );
}

function Colours({ part }: { part: MetricsPart }) {
  const c = part.color;
  if (!c) return null;
  const entries = [
    ["fg", c.fg],
    ["bg", c.bg],
    ["border", c.border],
  ] as const;
  return (
    <Stack gap="xs">
      {entries.map(([label, hex]) => hex && <Swatch key={label} label={label} hex={hex} />)}
    </Stack>
  );
}

/** One measured value on its own line, label first; nothing for a value the part does not have. */
function Line({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <span className="whitespace-nowrap">
      <Caption as="span" mono>
        {label} {value}
      </Caption>
    </span>
  );
}

function Measured({ part }: { part: MetricsPart }) {
  return (
    <Stack gap="xs">
      <Line label="box" value={boxText(part)} />
      <Line label="padding" value={paddingText(part)} />
      <Line label="gap" value={part.gap === undefined ? null : n(part.gap)} />
      <Line label="font" value={fontText(part)} />
      <Colours part={part} />
    </Stack>
  );
}

export function MetricsPanel({ metrics }: { metrics: Metrics | null }) {
  if (!metrics) return null;
  const names = Object.keys(metrics.parts);
  return (
    <Disclosure
      summary={
        <Text strong as="span" data-testid="metrics-summary">
          Layout metrics ({names.length} {names.length === 1 ? "part" : "parts"})
        </Text>
      }
    >
      <Stack gap="xs" data-testid="metrics">
        <Caption as="p">
          Logical px, from the top-left of{" "}
          <Text strong as="span">
            {metrics.root}
          </Text>
          . Padding is top right bottom left; font is size/line height · weight.
        </Caption>
        <Stack gap="sm" as="ul" aria-label="Layout metrics per part">
          {names.map((name) => {
            const part = metrics.parts[name];
            if (!part) return null;
            return (
              <li key={name} data-testid="metrics-part" data-part-name={name}>
                <Stack gap="xs">
                  <Text strong as="span">
                    {name}
                  </Text>
                  <Measured part={part} />
                </Stack>
              </li>
            );
          })}
        </Stack>
      </Stack>
    </Disclosure>
  );
}
