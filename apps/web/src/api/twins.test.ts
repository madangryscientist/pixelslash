import { describe, expect, test } from "vitest";
import { createOrg, createProject } from "#/db/orgs";
import { signInGithubUser } from "#/db/users";
import { get } from "./test-read";
import { SHA } from "./test-support";
import {
  ANDROID,
  PIXEL,
  WEB,
  jsonOf,
  putTwin,
  readBuild,
  readTwins,
  upload,
  world,
} from "./twins-support";

/** Twin snapshots on the API (PS-295): the `twins` section of a build and the twin-project link. */

describe("the twins section of a build", () => {
  test("a web-only build carries no twins key at all", async () => {
    const { deps, acme } = await world();
    const id = await upload(deps, acme.token, [WEB]);
    expect("twins" in (await readBuild(deps, id, acme.token))).toBe(false);
  });

  test("a web and an android shot of one build are twins, and a native-only one is unlinked", async () => {
    const { deps, acme } = await world();
    const id = await upload(deps, acme.token, [
      WEB,
      ANDROID,
      { ...PIXEL, name: "Button/loading", theme: "dark" },
    ]);
    const twins = await readTwins(deps, id, acme.token);
    expect(twins.twin_project).toBeNull();
    expect(twins.linked.map((e) => e.name).toSorted()).toEqual([
      "Button/primary",
      "Button/primary",
    ]);
    const web = twins.linked.find((e) => e.platform === "web");
    expect(web).toMatchObject({
      name: "Button/primary",
      theme: "dark",
      platform: "web",
      device: null,
      has_metrics: false,
      missing: [],
    });
    expect(web?.twins).toEqual([
      expect.objectContaining({
        platform: "android",
        device: "Pixel 8 API 35",
        viewport: "412x915",
        project_id: acme.project.id,
        build_id: id,
        source: "build",
        source_label: "same build",
        commit_sha: null,
        has_metrics: false,
      }),
    ]);
    expect(twins.unlinked).toEqual([
      expect.objectContaining({
        name: "Button/loading",
        theme: "dark",
        platform: "android",
        twins: [],
        missing: ["web"],
      }),
    ]);
  });

  test("a linked project's build at the same commit is the twin, named by its sha", async () => {
    const { deps, acme, ada, native, nativeCi } = await world();
    await upload(deps, acme.token, [WEB]);
    const id = await upload(deps, nativeCi, [ANDROID]);
    expect((await putTwin(deps, native.id, ada, { twin_project_id: acme.project.id })).status).toBe(
      200,
    );
    const twins = await readTwins(deps, id, ada);
    expect(twins.twin_project).toEqual({ id: acme.project.id, name: "web" });
    expect(twins.unlinked).toEqual([]);
    expect(twins.linked).toHaveLength(1);
    expect(twins.linked[0]?.twins[0]).toMatchObject({
      platform: "web",
      project_id: acme.project.id,
      project_name: "web",
      source: "commit",
      source_label: `same commit ${SHA.slice(0, 7)}`,
      commit_sha: SHA,
    });
  });

  test("a project's own CI token never reads across to the linked project", async () => {
    const { deps, acme, ada, native, nativeCi } = await world();
    await upload(deps, acme.token, [WEB]);
    const id = await upload(deps, nativeCi, [ANDROID]);
    await putTwin(deps, native.id, ada, { twin_project_id: acme.project.id });
    expect("twins" in (await readBuild(deps, id, nativeCi))).toBe(false);
  });
});

describe("PUT /api/v1/projects/:id/twin", () => {
  test("links a project of the same org, shows on the project, and null clears it", async () => {
    const { deps, acme, ada, native } = await world();
    const linked = await putTwin(deps, native.id, ada, { twin_project_id: acme.project.id });
    expect(linked.status).toBe(200);
    expect((await jsonOf(linked)).project).toMatchObject({
      id: native.id,
      twin_project_id: acme.project.id,
    });
    const listed = await get(deps, "/api/v1/projects", ada);
    const rows: { id: string; twin_project_id: string | null }[] = listed.body.projects;
    expect(rows.find((p) => p.id === native.id)?.twin_project_id).toBe(acme.project.id);
    expect(rows.find((p) => p.id === acme.project.id)?.twin_project_id).toBeNull();

    const cleared = await putTwin(deps, native.id, ada, { twin_project_id: null });
    expect(cleared.status).toBe(200);
    expect((await jsonOf(cleared)).project.twin_project_id).toBeNull();
  });

  test("another org's project, an unknown one, itself and a bad body are 400", async () => {
    const { deps, other, ada, native } = await world();
    const foreign = await putTwin(deps, native.id, ada, { twin_project_id: other.project.id });
    expect(foreign.status).toBe(400);
    const unknown = await putTwin(deps, native.id, ada, { twin_project_id: "nope" });
    expect(unknown.status).toBe(400);
    const self = await putTwin(deps, native.id, ada, { twin_project_id: native.id });
    expect(self.status).toBe(400);
    for (const body of [{}, { twin_project_id: 7 }, { twin_project_id: "" }]) {
      expect([body, (await putTwin(deps, native.id, ada, body)).status]).toEqual([body, 400]);
    }
  });

  test("a non-member gets the 404 every project read gives, a CI token a 403, no token a 401", async () => {
    const { deps, acme, ada, eve, native, nativeCi } = await world();
    const stranger = await putTwin(deps, native.id, eve, { twin_project_id: acme.project.id });
    expect(stranger.status).toBe(404);
    expect((await putTwin(deps, native.id, nativeCi, { twin_project_id: null })).status).toBe(403);
    expect((await putTwin(deps, native.id, null, { twin_project_id: null })).status).toBe(401);
    // And nothing was linked by any of them.
    const listed = await get(deps, "/api/v1/projects", ada);
    const rows: { id: string; twin_project_id: string | null }[] = listed.body.projects;
    expect(rows.find((p) => p.id === native.id)?.twin_project_id).toBeNull();
  });

  test("an org the user is not a member of cannot be linked to, even one they created elsewhere", async () => {
    const { db, deps, ada, native, acme } = await world();
    const eve = await signInGithubUser(db, {
      githubId: 3,
      login: "zed",
      name: null,
      avatarUrl: null,
    });
    const org = await createOrg(db, eve.id, "Zed");
    const theirs = await createProject(db, eve.id, org.id, "theirs");
    const res = await putTwin(deps, native.id, ada, { twin_project_id: theirs.id });
    expect(res.status).toBe(400);
    expect(acme.org.id).not.toBe(org.id);
  });
});
