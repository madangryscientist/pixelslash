import { Caption, Cluster, SegmentedControl, Text } from "@hackcove/ui-react";
import { useHydrated } from "#/components/ui";
import type { BaseId, Bases } from "#/lib/viewer-bases";

/**
 * What the left pane is compared with. Two options when the shot differs from main and was first
 * compared with an earlier build of its branch (a keyboard-reachable switch, like the mode picker);
 * otherwise one line saying why there is no switch, or nothing. The line under the switch states
 * what the chosen pair measured, from the stored result.
 */
export function BaseSwitch({
  bases,
  selected,
  summary,
  onSelect,
}: {
  bases: Bases;
  selected: BaseId;
  summary: string | null;
  onSelect: (id: BaseId) => void;
}) {
  const hydrated = useHydrated();
  const switchable = bases.options.length > 1;
  if (!switchable && !bases.note) return null;
  return (
    <Cluster gap="sm" wrap data-testid="base-switch">
      {switchable && (
        <SegmentedControl
          label="Compared with"
          value={selected}
          disabled={!hydrated}
          onChange={(id) => {
            const option = bases.options.find((candidate) => candidate.id === id);
            if (option) onSelect(option.id);
          }}
          items={bases.options.map((option) => ({
            value: option.id,
            label: option.switchLabel,
          }))}
        />
      )}
      {switchable && summary && (
        <Text as="span" data-testid="base-summary">
          {summary}
        </Text>
      )}
      {!switchable && bases.note && <Caption data-testid="base-note">{bases.note}</Caption>}
    </Cluster>
  );
}
