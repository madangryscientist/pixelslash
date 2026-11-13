import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { buildView } from "#/db/review";
import { builds } from "#/db/schema";
import { walkAround } from "#/lib/review-walk";
import { summaryCounts } from "#/lib/summary-counts";
import { type BuildSpec, type Ctx, type Shot, context, sha, upload as send } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * What a reviewer reads on a branch build held open by differences from main (PS-285), after the
 * same shots were uploaded twice and the first upload was never accepted: the verdict, the line
 * that states the carried shots, and the order the j/k walk visits them in. The counts and the
 * groups are `process-open-vs-main.test.ts`'s.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

let clock = 0;

/** Upload, then date the build a second after the last one: the branch's newest build must be unambiguous. */
async function upload(ctx: Ctx, spec: BuildSpec) {
  const build = await send(ctx, spec);
  clock += 1;
  await ctx.db
    .update(builds)
    .set({ createdAt: new Date(Date.now() - 600_000 + clock * 1000) })
    .where(eq(builds.id, build.id));
  return build;
}

const feat = (): Shot[] => [
  { name: "home", png: white },
  { name: "about", png: red },
  { name: "pricing", png: red },
];

const onFeat = (commit: number): BuildSpec => ({
  branch: "feat",
  commit: sha(commit),
  mergeBase: sha(1),
  ancestors: commit === 2 ? [sha(1)] : [sha(2), sha(1)],
  shots: feat(),
});

test("a build held open by differences from main says changes, states the carried shots, and the j/k walk visits them first", async () => {
  const ctx = await context();
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [
      { name: "home", png: white },
      { name: "about", png: white },
      { name: "faq", png: white },
    ],
  });
  await upload(ctx, onFeat(2));
  // The same shots again: nothing changed since the last build, and the first was never accepted.
  const next = await upload(ctx, onFeat(3));
  expect(next.status).toBe("changes");

  const view = await buildView(ctx.db, ctx.projectId, next.id);
  const line = summaryCounts(view.snapshots, view.build.brief);
  expect(line).toContain("1 changed and 1 new carried from main");
  expect(line).not.toContain("Nothing changed");

  // The walk is the build's order: Changed, then New, then the rest.
  const [first] = view.snapshots;
  if (!first) throw new Error("no shots");
  const walked = [];
  for (let at = walkAround(view.snapshots, first.id); at;) {
    walked.push([at.shot.name, at.position, at.total]);
    at = at.nextId ? walkAround(view.snapshots, at.nextId) : null;
  }
  expect(walked).toEqual([
    ["about", 1, 3],
    ["pricing", 2, 3],
    ["home", 3, 3],
  ]);
});
