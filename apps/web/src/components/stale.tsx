import { Caption, Card, Cluster, ListRow, Pill, Section, Text, TextLink } from "@hackcove/ui";
import { Link } from "@tanstack/react-router";
import { type StaleItem, staleParts } from "#/lib/stale";

/** The marker on a twin whose web side changed since a reviewer last accepted it (PS-297). */
export function StaleBadge() {
  return (
    <Pill tone="amber" data-testid="stale-badge">
      Stale
    </Pill>
  );
}

/**
 * The project page's Stale list (PS-297): one sentence per stale native twin, with the build that
 * changed the web shot as a link, and a link to the native shot a reviewer accepts. Nothing when no
 * twin is stale, so a web-only project's page is the one it always was.
 */
export function StaleList({ items }: { items: StaleItem[] }) {
  if (items.length === 0) return null;
  return (
    <Section
      title={
        <>
          Stale <Text tone="muted">{items.length}</Text>
        </>
      }
    >
      <Card flush>
        {items.map((item, i) => {
          const { before, after } = staleParts(item);
          const shot = item.shots[0];
          return (
            <ListRow
              key={`${item.platform}:${item.name}:${item.theme}`}
              static
              divided={i > 0}
              data-testid="stale-item"
              leading={<StaleBadge />}
            >
              <Cluster gap="xs" align="baseline" wrap>
                <Text as="span">
                  {before}
                  <TextLink
                    data-testid="stale-cause"
                    render={(p) => (
                      <Link
                        to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                        params={{
                          projectId: item.cause.projectId,
                          buildId: item.cause.buildId,
                          snapshotId: item.cause.snapshotId,
                        }}
                        {...p}
                      />
                    )}
                  >
                    {item.cause.buildId.slice(0, 8)}
                  </TextLink>
                  {after}
                </Text>
                {shot && (
                  <TextLink
                    size="sm"
                    data-testid="stale-shot"
                    render={(p) => (
                      <Link
                        to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                        params={{
                          projectId: shot.projectId,
                          buildId: shot.buildId,
                          snapshotId: shot.snapshotId,
                        }}
                        {...p}
                      />
                    )}
                  >
                    Review the {item.platform} shot
                  </TextLink>
                )}
              </Cluster>
              {item.shots.length > 1 && (
                <Caption tone="muted">{item.shots.length} devices and sizes</Caption>
              )}
            </ListRow>
          );
        })}
      </Card>
    </Section>
  );
}
