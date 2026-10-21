import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { crumbLinkClass } from "./shell";

/** The crumbs the review pages share, so each page lists only the ones above it. */
export function orgCrumb(org: { id: string; name: string }): ReactNode {
  return (
    <Link key={org.id} to="/orgs" className={crumbLinkClass}>
      {org.name}
    </Link>
  );
}

export function projectCrumb(project: { id: string; name: string }): ReactNode {
  return (
    <Link
      key={project.id}
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className={crumbLinkClass}
    >
      {project.name}
    </Link>
  );
}

/** The build, by branch and short commit: the commit is a key, so it is set in mono. */
export function buildCrumbLabel(build: { branch: string; commitSha: string }): ReactNode {
  return (
    <>
      {build.branch} <span className="font-mono text-xs">{build.commitSha.slice(0, 7)}</span>
    </>
  );
}

export function buildCrumb(
  projectId: string,
  build: { id: string; branch: string; commitSha: string },
): ReactNode {
  return (
    <Link
      key={build.id}
      to="/projects/$projectId/builds/$buildId"
      params={{ projectId, buildId: build.id }}
      className={crumbLinkClass}
    >
      {buildCrumbLabel(build)}
    </Link>
  );
}
