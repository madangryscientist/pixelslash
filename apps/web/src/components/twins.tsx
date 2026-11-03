import { Caption, Overline, Stack, Text, TextLink } from "@hackcove/ui";
import { Link } from "@tanstack/react-router";
import { StaleBadge } from "#/components/stale";
import { staleDate } from "#/lib/stale";
import {
  type BuildTwins,
  type TwinEntry,
  twinLabel,
  twinSourceLabel,
  unlinkedLine,
} from "#/lib/twins";

/**
 * The Twins row of a shot's side panel (PS-295): the same name and theme on another platform, each
 * a link labelled by platform and device. Nothing when no other platform is in play.
 */
export function TwinsRow({ entry }: { entry: TwinEntry | null }) {
  if (!entry) return null;
  return (
    <Stack as="section" gap="xs" data-testid="twins">
      <Overline as="h2" tone="muted">
        Twins
      </Overline>
      <Stack as="ul" gap="xs">
        {entry.twins.map((t) => (
          <li key={t.snapshotId} data-testid="twin">
            <TextLink
              render={(p) => (
                <Link
                  to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                  params={{
                    projectId: t.projectId,
                    buildId: t.buildId,
                    snapshotId: t.snapshotId,
                  }}
                  {...p}
                />
              )}
            >
              {twinLabel(t)}
            </TextLink>
            {t.stale && (
              <>
                {" "}
                <StaleBadge />
                <Caption as="p" tone="muted" data-testid="twin-stale-cause">
                  web changed, accepted by {t.stale.acceptedBy ?? "someone"}{" "}
                  {staleDate(t.stale.acceptedAt)}
                </Caption>
              </>
            )}
            <Caption as="p" tone="muted">
              {t.viewport} · {twinSourceLabel(t.source)}
            </Caption>
          </li>
        ))}
        {entry.missing.length > 0 && (
          <li data-testid="twin-missing">
            <Text as="span" tone="muted">
              {`No ${entry.missing.join(" or ")} twin`}
            </Text>
          </li>
        )}
      </Stack>
    </Stack>
  );
}

/** The shots of a build that miss a platform the project has (PS-295), as the CLI prints them. */
export function UnlinkedShots({
  projectId,
  buildId,
  twins,
}: {
  projectId: string;
  buildId: string;
  twins: BuildTwins;
}) {
  if (twins.unlinked.length === 0) return null;
  return (
    <Stack as="section" gap="xs" data-testid="unlinked">
      <Overline as="h2" tone="muted">
        Unlinked
      </Overline>
      <Stack as="ul" gap="xs">
        {twins.unlinked.map((e) => (
          <li key={e.snapshotId} data-testid="unlinked-shot">
            <TextLink
              render={(p) => (
                <Link
                  to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                  params={{ projectId, buildId, snapshotId: e.snapshotId }}
                  {...p}
                />
              )}
            >
              {unlinkedLine(e)}
            </TextLink>
          </li>
        ))}
      </Stack>
    </Stack>
  );
}
