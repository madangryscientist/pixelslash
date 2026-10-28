import { Body, Caption, Disclosure, Stack, SubsectionHeading } from "@hackcove/ui";
import { MAX_VIOLATIONS, type A11yDiff, type A11yViolation } from "@pixelslash/engine/a11y-entry";

/**
 * A shot's accessibility scan against its baseline's (PS-238): the violations new on Branch first,
 * then the ones already there. Shown, never a review state, and a shot that was not scanned shows
 * nothing at all.
 */

function ViolationList({ label, violations }: { label: string; violations: A11yViolation[] }) {
  return (
    <Stack as="ul" gap="sm" aria-label={label}>
      {violations.map((v, i) => (
        // Scan order, fixed for one page load.
        <li key={i}>
          <Stack gap="xs">
            <Body as="p">
              <strong>{v.rule}</strong>
              {v.impact ? ` (${v.impact})` : ""}: {v.help}
            </Body>
            <div className="break-all">
              <Caption as="p" mono>
                {v.selector}
              </Caption>
            </div>
          </Stack>
        </li>
      ))}
    </Stack>
  );
}

const noun = (n: number) => (n === 1 ? "violation" : "violations");

/** The count a card and the panel's heading give: what is new, or all of it when it cannot be told. */
export function a11yLine(diff: A11yDiff): string | null {
  if (diff.state === "off") return null;
  if (diff.state === "unbaselined")
    return `a11y: ${diff.found.length} ${noun(diff.found.length)} (no scanned baseline)`;
  return `a11y: ${diff.fresh.length} new on Branch`;
}

export function A11yPanel({ diff }: { diff: A11yDiff }) {
  if (diff.state === "off") return null;
  const omitted = diff.omitted > 0 && (
    <Body as="p" tone="muted">
      {diff.omitted} more past the cap of {MAX_VIOLATIONS} a shot were not kept, so this list may be
      incomplete.
    </Body>
  );
  if (diff.state === "unbaselined") {
    return (
      <Stack as="section" gap="sm" aria-label="Accessibility">
        <SubsectionHeading as="h2" size="sm">
          Accessibility on Branch ({diff.found.length})
        </SubsectionHeading>
        <Body as="p" tone="muted">
          There is no scan on the baseline (or no baseline), so nothing here can be called new.
        </Body>
        {diff.found.length > 0 && <ViolationList label="Violations" violations={diff.found} />}
        {omitted}
      </Stack>
    );
  }
  return (
    <Stack as="section" gap="sm" aria-label="Accessibility">
      {omitted}
      <SubsectionHeading as="h2" size="sm">
        Accessibility: new on Branch ({diff.fresh.length})
      </SubsectionHeading>
      {diff.fresh.length === 0 ? (
        <Body as="p" tone="muted">
          Nothing new on Branch.
        </Body>
      ) : (
        <ViolationList label="New violations" violations={diff.fresh} />
      )}
      {diff.already.length > 0 && (
        <Disclosure summary={`Already on the baseline (${diff.already.length})`}>
          <ViolationList label="Existing violations" violations={diff.already} />
        </Disclosure>
      )}
    </Stack>
  );
}
