/** An org's projects as its page lists them: each top-level project, then its subprojects. */

type Node = { id: string; name: string; parentProjectId: string | null; defaultBranch: string };

/**
 * `projects` (already in name order) with each subproject right after its parent, given its
 * parent's name and default branch: a subproject's own column is never the one acted on.
 */
export function nestProjects<P extends Node>(projects: P[]): (P & { parentName: string | null })[] {
  const tops = projects.filter((p) => p.parentProjectId === null);
  return tops.flatMap((top) => [
    { ...top, parentName: null },
    ...projects
      .filter((p) => p.parentProjectId === top.id)
      .map((sub) => ({ ...sub, defaultBranch: top.defaultBranch, parentName: top.name })),
  ]);
}
