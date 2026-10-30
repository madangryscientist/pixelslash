import { Avatar, Button, Caption, ListRow, Overline, Pill, Stack } from "@hackcove/ui";
import { Link } from "@tanstack/react-router";
import type { OrgOverview } from "#/db/orgs";

/**
 * The organizations down the left, each with how many of its projects have a latest build waiting
 * on a decision. The badge is amber when there is work and a plain grey count when there is not.
 */
export function OrgRail({
  orgs,
  selectedId,
  onNew,
  hydrated,
}: {
  orgs: OrgOverview[];
  selectedId: string | null;
  onNew: () => void;
  hydrated: boolean;
}) {
  return (
    <Stack gap="sm">
      <Overline as="h2">Organizations</Overline>
      <nav aria-label="Organizations">
        <Stack gap="xs">
          {orgs.map((org) => (
            <ListRow
              key={org.id}
              size="sm"
              selected={org.id === selectedId}
              leading={<Avatar name={org.name} size="sm" shape="square" />}
              trailing={
                org.waiting > 0 ? (
                  <Pill
                    tone="amber"
                    round
                    title={`${org.waiting} ${org.waiting === 1 ? "project has" : "projects have"} shots to review`}
                  >
                    {org.waiting}
                  </Pill>
                ) : (
                  <Caption>0</Caption>
                )
              }
              render={(props) => <Link to="/orgs" search={{ org: org.id }} {...props} />}
            >
              {org.name}
            </ListRow>
          ))}
        </Stack>
      </nav>
      <Button variant="dashed" disabled={!hydrated} onClick={onNew}>
        New organization
      </Button>
    </Stack>
  );
}
