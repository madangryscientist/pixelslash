import { createServerFn } from "@tanstack/react-start";
import { setGithubRepo } from "#/db/orgs";
import { repoNameOf } from "#/github/app";
import { database } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/** Connect the project to a GitHub repo (`owner/name`), or disconnect it with `repo: null` (PS-23). */
export const saveGithubRepo = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const projectId = field(d, "projectId");
    const raw = typeof d === "object" && d !== null ? Reflect.get(d, "repo") : undefined;
    if (raw === null) return { projectId, repo: null };
    const repo = repoNameOf(field(d, "repo"));
    if (!repo) throw new Error("repo must be owner/name, e.g. acme/web");
    return { projectId, repo };
  })
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(setGithubRepo(database(), user.id, data.projectId, data.repo));
  });
