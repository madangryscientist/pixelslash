import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/** Go to another shot of the same build; null (the end of the walk) goes nowhere. */
export function useWalk(projectId: string, buildId: string) {
  const navigate = useNavigate();
  return useCallback(
    (id: string | null) => {
      if (!id) return;
      void navigate({
        to: "/projects/$projectId/builds/$buildId/snapshots/$snapshotId",
        params: { projectId, buildId, snapshotId: id },
      });
    },
    [navigate, projectId, buildId],
  );
}
