import { TextLink } from "@hackcove/ui-react";
import { Link } from "@tanstack/react-router";
import type { BuildLink } from "#/lib/viewer-bases";

/** The earlier build's name in the left pane links to its shot. */
export const linkToBuild =
  (projectId: string): BuildLink =>
  (build, text) => (
    <TextLink
      render={(p) => (
        <Link
          to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
          params={{ projectId, buildId: build.buildId, snapshotId: build.snapshotId }}
          {...p}
        />
      )}
    >
      {text}
    </TextLink>
  );
