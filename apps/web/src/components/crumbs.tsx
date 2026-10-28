import { Caption, type Crumb } from "@hackcove/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** The crumbs the review pages share, so each page lists only the ones above it. */
export function orgCrumb(org: { id: string; name: string }): Crumb {
  return { label: org.name, render: (props) => <Link to="/orgs" {...props} /> };
}

export function projectCrumb(project: { id: string; name: string }): Crumb {
  return {
    label: project.name,
    render: (props) => (
      <Link to="/projects/$projectId" params={{ projectId: project.id }} {...props} />
    ),
  };
}

/** The build, by branch and short commit: the commit is a key, so it is set in mono. */
export function buildCrumbLabel(build: { branch: string; commitSha: string }): ReactNode {
  return (
    <>
      {build.branch} <Caption mono>{build.commitSha.slice(0, 7)}</Caption>
    </>
  );
}

export function buildCrumb(
  projectId: string,
  build: { id: string; branch: string; commitSha: string },
): Crumb {
  return {
    label: buildCrumbLabel(build),
    render: (props) => (
      <Link
        to="/projects/$projectId/builds/$buildId"
        params={{ projectId, buildId: build.id }}
        {...props}
      />
    ),
  };
}
