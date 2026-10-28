import { Body, Caption, Disclosure, KeyValue, KeyValueList, Overline, Stack } from "@hackcove/ui";
import type { SnapshotView } from "#/db/review";
import type { DiffOptions, OptionSource } from "#/db/schema";
import { formatDateTime } from "#/lib/format";

const OPTION_KEYS: (keyof DiffOptions)[] = [
  "threshold",
  "minChangedPixels",
  "minChangedRatio",
  "mergeDistance",
  "minRegionArea",
  "noiseAmplitude",
  "maxShift",
];

/** Where a value came from, in the words the ticket asked for (ob 1495). */
function sourceText(source: OptionSource | undefined, config: number | undefined): string | null {
  if (!source) return null;
  if (source.from === "config") return "set in the config";
  const scope = source.scope === "variant" ? "this test, this variant" : "this test";
  const was = config === undefined ? "engine default" : String(config);
  return `set in the UI by @${source.by} on ${formatDateTime(new Date(source.at))} (${scope}); config says ${was}`;
}

/** The ignore areas the diff skipped, or that it measured every pixel. */
function ignoreLine(snapshot: SnapshotView): string {
  const n = snapshot.ignore.length;
  if (n > 0) return `${n} ignore area${n === 1 ? "" : "s"} skipped.`;
  return snapshot.diffResult?.settledBy
    ? "No ignore areas."
    : "No ignore areas: every pixel was measured.";
}

/**
 * The options the diff ran with, and the source of each: one line when every one is the engine's
 * default. A server-measured shot carries what it was measured with (overrides included); a CI
 * shot only the config's.
 */
export function Options({ snapshot, options }: { snapshot: SnapshotView; options: DiffOptions }) {
  const resolved = snapshot.resolvedDiff;
  const used = resolved?.options ?? options;
  const sourceOf = (key: keyof DiffOptions) => {
    if (resolved) return sourceText(resolved.sources[key], options[key]);
    return used[key] === undefined ? null : "set in the config";
  };
  const allDefault = OPTION_KEYS.every((key) => used[key] === undefined);
  const list = (
    <KeyValueList data-testid="diff-options">
      {OPTION_KEYS.map((key) => {
        const source = sourceOf(key);
        return (
          <div key={key}>
            <KeyValue label={key}>
              <span data-testid={`option-${key}`}>{used[key] ?? "engine default"}</span>
            </KeyValue>
            {source && (
              <Caption as="p" data-testid={`source-${key}`} tone="muted">
                {source}
              </Caption>
            )}
          </div>
        );
      })}
    </KeyValueList>
  );
  return (
    <Stack as="section" gap="xs">
      <Overline as="h2" tone="muted">
        Diff options
      </Overline>
      {allDefault ? (
        <Disclosure
          summary={
            <Body as="span" tone="muted">
              All engine defaults
            </Body>
          }
        >
          {list}
        </Disclosure>
      ) : (
        list
      )}
      <Body as="p" tone="muted">
        {ignoreLine(snapshot)}
      </Body>
    </Stack>
  );
}
