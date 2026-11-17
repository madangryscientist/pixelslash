import { describe, expect, test, vi } from "vitest";
import { branchView } from "#/db/branch-view";
import { buildView } from "#/db/review";
import { context, sha, upload } from "#/diff/test-builds";
import { card, red, stubModel, white, withModel } from "#/ai/summary-test-kit";
import { byTestId } from "#/test/by-test-id";
import { renderRouted, textOf } from "#/test/render-routed";
import { BuildSummary } from "./build-summary";

// The Regenerate button's server function reads the Worker's env, which a Node test has none of.
vi.mock("#/server/model", () => ({ regenerateBuildSummary: vi.fn<() => Promise<never>>() }));

/**
 * A build's brief (PS-232) in the build page's summary: the model's sentences, then its closing
 * read of whether the changes match the brief, and which model wrote it. The brief decides nothing:
 * the build waits on a person as it would without one. The summary is written by a stubbed model
 * after a real diff; the prompt and the answer's parsing are `ai/summary-brief.test.ts`.
 */

const BRIEF = "Nudge the **hero** text.\n<b>Not bold</b>";
const ANSWER = [
  "The hero's text edges moved by a sub-pixel. [C1]",
  "Brief: the hero changed as the brief says; nothing it describes is missing. [C1]",
].join("\n");

async function draw(
  build: Awaited<ReturnType<typeof upload>>,
  ctx: Awaited<ReturnType<typeof context>>,
) {
  const view = await buildView(ctx.db, ctx.projectId, build.id);
  return renderRouted(
    <BuildSummary
      projectId={ctx.projectId}
      build={view.build}
      snapshots={view.snapshots}
      modelConfigured
      pending={false}
    />,
  );
}

describe("a summary read against the brief", () => {
  test("states the model's sentence, then whether the changes match, and says it was read against the brief", async () => {
    const ctx = await context();
    await withModel(ctx);
    const stub = stubModel(() => ANSWER);
    await upload(ctx, { branch: "main", commit: sha(1), shots: card(white) });
    const build = await upload(
      ctx,
      {
        branch: "work",
        commit: sha(2),
        mergeBase: sha(1),
        ancestors: [sha(1)],
        shots: card(red),
        brief: BRIEF,
      },
      { modelFetch: stub.modelFetch },
    );
    // The brief decides nothing: the build waits on a person as it would without one.
    expect(build.status).toBe("changes");
    expect(build.brief).toBe(BRIEF);

    // The branch page draws the brief of the branch's newest build.
    expect((await branchView(ctx.db, ctx.projectId, "work"))?.build.brief).toBe(BRIEF);

    const html = await draw(build, ctx);
    expect(textOf(html)).toMatch(/The hero's text edges moved by a sub-pixel\./);
    expect(byTestId(html, "summary-match")).toMatch(
      /^Against the brief: the hero changed as the brief says; nothing it describes is missing\./,
    );
    expect(byTestId(html, "summary-model")).toContain("local-qwen");
    expect(byTestId(html, "summary-model")).toContain("read against the brief");
  });

  test("a brief with nothing changed is no match: the page says there was nothing to read against it", async () => {
    const ctx = await context();
    await withModel(ctx);
    await upload(ctx, { branch: "main", commit: sha(1), shots: card(white) });
    const build = await upload(
      ctx,
      {
        branch: "same",
        commit: sha(3),
        mergeBase: sha(1),
        ancestors: [sha(1)],
        shots: card(white),
        brief: "Change nothing.",
      },
      { modelFetch: stubModel().modelFetch },
    );
    const html = await draw(build, ctx);
    expect(html).not.toContain('data-testid="summary-match"');
    expect(byTestId(html, "summary-counts")).toMatch(
      /^Nothing changed, so there is nothing to read against the brief\./,
    );
  });
});
