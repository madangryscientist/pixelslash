import { Link } from "@tanstack/react-router";
import {
  BulletList,
  Caption,
  Card,
  Cluster,
  type LinkRenderProps,
  Pill,
  Stack,
  SubsectionHeading,
  Tabs,
  Text,
} from "@hackcove/ui";
import type { ChangeLine, MainSummary } from "#/lib/branch-review";

export type BranchMode = "main" | "since";

/** The verdict reads the review states and nothing else; it is not an approval of its own. */
function verdictText(summary: MainSummary, status: string): string {
  if (summary.ready) return "Ready to merge";
  const open = [
    summary.waiting > 0 ? `${summary.waiting} waiting` : null,
    summary.rejected > 0 ? `${summary.rejected} rejected` : null,
    summary.unmeasured > 0 ? `${summary.unmeasured} not measured against main` : null,
  ].filter((part) => part !== null);
  if (open.length === 0) return `Not ready to merge: the newest build is ${status}`;
  return `Not ready to merge: ${open.join(", ")}`;
}

export function MainSummaryBox({ summary, status }: { summary: MainSummary; status: string }) {
  const counts: [string, number, string][] = [
    ["changed", summary.changed, "changed against main"],
    ["accepted", summary.accepted, "accepted"],
    ["waiting", summary.waiting, "waiting"],
    ["rejected", summary.rejected, "rejected"],
  ];
  return (
    <Card as="div" data-testid="branch-summary">
      <Cluster gap="sm" justify="between" wrap>
        <Cluster gap="md" wrap>
          {counts.map(([id, n, label]) => (
            <Text key={id} tone="muted" data-testid={`summary-${id}`}>
              <Text strong numeric>
                {n}
              </Text>{" "}
              {label}
            </Text>
          ))}
        </Cluster>
        <Pill tone={summary.ready ? "emerald" : "amber"} data-testid="merge-verdict">
          {verdictText(summary, status)}
        </Pill>
      </Cluster>
    </Card>
  );
}

export function ModeTabs({
  projectId,
  branch,
  active,
}: {
  projectId: string;
  branch: string;
  active: BranchMode;
}) {
  const modes: { id: BranchMode; label: string }[] = [
    { id: "main", label: "Against main" },
    { id: "since", label: "Since last build" },
  ];
  return (
    <Tabs
      variant="pill"
      label="Read the branch"
      value={active}
      items={modes.map((mode) => ({
        value: mode.id,
        label: mode.label,
        render: (props: LinkRenderProps) => (
          <Link
            to="/projects/$projectId/branches/$branch"
            params={{ projectId, branch }}
            search={mode.id === "main" ? {} : { mode: mode.id }}
            replace
            resetScroll={false}
            data-testid={`mode-${mode.id}`}
            {...props}
          />
        ),
      }))}
    />
  );
}

/**
 * One line per changed shot, in the order the mode groups them. A judge's note comes first when
 * there is one; the measured facts always follow, so a note never stands in for a measurement.
 */
export function ChangeSummary({
  title,
  detail,
  lines,
  empty,
}: {
  title: string;
  detail: string;
  lines: ChangeLine[];
  empty: string;
}) {
  const described = lines.some((line) => line.note !== null);
  return (
    <Card as="div" size="sm" data-testid="change-summary">
      <Stack gap="xs">
        <SubsectionHeading>
          {title} <Caption>{detail}</Caption>
        </SubsectionHeading>
        {lines.length === 0 ? (
          <Text as="p" tone="muted">
            {empty}
          </Text>
        ) : (
          <BulletList>
            {lines.map((line) => (
              <Text as="li" key={line.id} data-testid="change-line">
                <Text strong>{line.name}</Text> <Text tone="muted">{line.variant}</Text>:{" "}
                {line.note && <span data-testid="change-note">{line.note}. </span>}
                {line.facts}. <Text tone="muted">{line.state}</Text>
              </Text>
            ))}
          </BulletList>
        )}
        {described && (
          <Caption as="p" data-testid="change-note-source">
            Described by the judge (local model); sizes and pixel counts are measured.
          </Caption>
        )}
      </Stack>
    </Card>
  );
}
