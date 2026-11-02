import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { setGithubComment } from "#/db/github-comment";
import { setGithubRepo } from "#/db/orgs";
import { builds } from "#/db/schema";
import { prComments } from "#/db/schema-pr-comments";
import { sha } from "#/diff/test-builds";
import { type GithubApp, field } from "./app";
import { syncCheckRuns } from "./check-run";
import { CHANGED, PLAIN, world } from "./test-world";

/** The PR comment on a build (PS-82), against a stand-in for GitHub's API. */

type World = Awaited<ReturnType<typeof world>>;

const page = (w: World, buildId: string) =>
  `https://pixelslash.test/projects/${w.acme.project.id}/builds/${buildId}`;

/** A main build, then a feature build of PR 7 with a change in it. */
async function pullRequest(w: World, commit = sha(2)) {
  await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
  return w.finalise({ commit, branch: "feat/x", mergeBase: sha(1), png: CHANGED, pr: 7 });
}

const commentBodies = (w: World) => [...w.github.comments().values()];

describe("the PixelSlash PR comment", () => {
  test("the first build of a PR makes one comment: counts, shots as links, the build page", async () => {
    const w = await world();
    const feature = await pullRequest(w);

    expect(w.github.commentCalls().map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/acme/web/issues/7/comments",
    ]);
    const [body] = commentBodies(w);
    expect(body).toContain("<!-- pixelslash:pr-comment -->");
    expect(body).toContain("1 change to review");
    expect(body).toContain("| 1 | 1 | 0 | 0 | 0 | 0 | 0 |");
    expect(body).toContain(`](${page(w, feature.id)}/snapshots/`);
    expect(body).toContain(`[Review the build](${page(w, feature.id)})`);
    expect(body).toContain("Summary skipped");
    expect(body).not.toContain("![");
  });

  test("a build with no PR, or a main build, makes no comment", async () => {
    const w = await world();
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    await w.finalise({ commit: sha(2), branch: "feat/x", mergeBase: sha(1), png: CHANGED });
    expect(w.github.commentCalls()).toEqual([]);
    expect(w.github.checkRunCalls().length).toBeGreaterThan(0);
  });

  test("a later build of the same PR edits that comment in place; accept and reject follow", async () => {
    const w = await world();
    const first = await pullRequest(w);
    const second = await w.finalise({
      commit: sha(3),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
      pr: 7,
    });
    await w.sync(await w.decide(second.id, "accepted"));
    await w.sync(await w.decide(second.id, "rejected"));

    expect(w.github.commentCalls().map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/acme/web/issues/7/comments",
      "PATCH /repos/acme/web/issues/comments/900",
      "PATCH /repos/acme/web/issues/comments/900",
      "PATCH /repos/acme/web/issues/comments/900",
    ]);
    expect(w.github.comments().size).toBe(1);
    const [body] = commentBodies(w);
    expect(body).toContain("1 change rejected");
    expect(body).toContain(page(w, second.id));
    expect(body).not.toContain(page(w, first.id));
    expect(await w.db.select().from(prComments)).toHaveLength(1);
  });

  test("the comment carries the AI summary, defused, or says plainly that there is none", async () => {
    const w = await world();
    const feature = await pullRequest(w);
    expect(commentBodies(w)[0]).toContain("Summary skipped");

    await w.db
      .update(builds)
      .set({
        aiSummary: {
          model: "m",
          at: 1,
          sentences: [{ text: "The header moved down, cc @octocat <b>now</b>.", shots: [] }],
          match: { text: "It matches the brief.", shots: [] },
        },
      })
      .where(eq(builds.id, feature.id));
    await w.sync([feature.id]);

    const body = commentBodies(w)[0] ?? "";
    expect(body).toContain("The header moved down, cc @​octocat \\<b\\>now\\</b\\>.");
    expect(body).toContain("Against the brief: It matches the brief.");
    expect(body).not.toContain("Summary skipped");
  });

  test("a summary still being written says so", async () => {
    const w = await world();
    const feature = await pullRequest(w);
    await w.db
      .update(builds)
      .set({ aiSummaryQueuedAt: new Date() })
      .where(eq(builds.id, feature.id));
    await w.sync([feature.id]);
    expect(commentBodies(w)[0]).toContain("The summary is being written");
  });

  test("an older build deciding late does not overwrite the newest build's comment", async () => {
    const w = await world();
    const first = await pullRequest(w);
    const second = await w.finalise({
      commit: sha(3),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
      pr: 7,
    });
    const before = w.github.commentCalls().length;
    await w.decide(first.id, "accepted");
    await w.sync([first.id]);
    expect(w.github.commentCalls()).toHaveLength(before);
    expect(commentBodies(w)[0]).toContain(page(w, second.id));
  });

  test("a comment someone deleted is made again", async () => {
    const w = await world();
    const feature = await pullRequest(w);
    expect(w.github.deleteComment(900)).toBe(true);
    await w.sync([feature.id]);

    expect(w.github.commentCalls().map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/acme/web/issues/7/comments",
      "PATCH /repos/acme/web/issues/comments/900",
      "POST /repos/acme/web/issues/7/comments",
    ]);
    expect([...w.github.comments().keys()]).toEqual([901]);
    const [held] = await w.db.select().from(prComments);
    expect(held?.commentId).toBe(901);
  });

  test("two syncs racing to the first comment leave one: the loser deletes its own", async () => {
    const w = await world();
    const feature = await pullRequest(w);
    await w.db.delete(prComments);
    w.github.deleteComment(900);
    const inner = w.github.app({ timeoutMs: 50 });
    const racing: GithubApp = {
      async request(repo, method, path, body) {
        const made = await inner.request(repo, method, path, body);
        if (method === "POST" && path.endsWith("/comments")) {
          // Another sync's comment lands, and is stored, before ours is.
          const winner = await inner.request(repo, method, path, body);
          const commentId = Number(field(winner, "id"));
          await w.db
            .insert(prComments)
            .values({ projectId: w.acme.project.id, prNumber: 7, commentId });
        }
        return made;
      },
    };
    await syncCheckRuns(
      { db: w.db, app: racing, token: null, publicUrl: "https://pixelslash.test/" },
      [feature.id],
    );

    const [held] = await w.db.select().from(prComments);
    expect([...w.github.comments().keys()]).toEqual([held?.commentId]);
    expect(held?.commentId).toBe(902);
  });

  test("the setting turns the comment off and the check stays", async () => {
    const w = await world();
    await setGithubComment(w.db, w.acme.user.id, w.acme.project.id, false);
    await pullRequest(w);
    expect(w.github.commentCalls()).toEqual([]);
    expect(w.github.checkRunCalls().length).toBeGreaterThan(0);
    expect(await w.db.select().from(prComments)).toEqual([]);
  });

  test("no GitHub connection, no call", async () => {
    for (const setting of [{ repo: null }, { app: false }]) {
      const w = await world(setting);
      await pullRequest(w);
      expect(w.github.calls).toEqual([]);
    }
  });

  test("the token transport comments too", async () => {
    const w = await world({ app: false, token: true });
    await pullRequest(w);
    expect(w.github.commentCalls().map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/acme/web/issues/7/comments",
    ]);
  });

  test("a project moved to another repo gets its own comment there", async () => {
    const w = await world();
    const feature = await pullRequest(w);
    await setGithubRepo(w.db, w.acme.user.id, w.acme.project.id, "acme/site");
    expect(await w.db.select().from(prComments)).toEqual([]);
    await w.sync([feature.id]);
    expect(w.github.commentCalls().at(-1)?.path).toBe("/repos/acme/site/issues/7/comments");
  });

  test.each([
    ["a 5xx", { status: 502 } as const],
    ["a timeout", "hang" as const],
  ])("%s from GitHub never changes the build's verdict", async (_, mode) => {
    const w = await world();
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    w.github.setMode(mode);
    const feature = await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
      pr: 7,
    });
    expect(feature.status).toBe(200);
    expect(feature.body.status).toBe("changes");
    expect((await w.buildRow(feature.id))?.status).toBe("changes");
    expect(await w.db.select().from(prComments)).toEqual([]);
  });

  test("a failing comment leaves the check run synced", async () => {
    const w = await world();
    const feature = await pullRequest(w);
    // The comment is deleted and the create fails: only the comment is lost.
    w.github.deleteComment(900);
    const accepted = await w.decide(feature.id, "accepted");
    w.github.failComments(500);
    await w.sync(accepted);
    const last = w.github.checkRunCalls().at(-1);
    expect(last?.raw).toContain("All changes accepted");
  });
});
