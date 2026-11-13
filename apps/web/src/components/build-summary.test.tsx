import { describe, expect, test, vi } from "vitest";
import { buildView } from "#/db/review";
import { context, sha, upload, type Shot } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { renderRouted, textOf } from "#/test/render-routed";
import { BuildSummary } from "./build-summary";

// The Regenerate button's server function reads the Worker's env, which a Node test has none of.
vi.mock("#/server/model", () => ({ regenerateBuildSummary: vi.fn<() => Promise<never>>() }));

/**
 * The build page's AI summary card when the model wrote no sentence: past the limit it says why, and
 * with no model it says `skip: no judge` and offers nothing to regenerate. A summary is never
 * invented. The card is drawn from a real build, diffed by the server.
 */

const white = shot();
const changed = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

/** Main and a branch of `count` shots of one name each, every branch shot changed. */
async function changedBuild(count: number, modelConfigured: boolean) {
  const ctx = await context();
  const names = Array.from({ length: count }, (_, i) => `page-${i}`);
  const spec = (png: Shot["png"]): Shot[] => names.map((name) => ({ name, png }));
  await upload(ctx, { branch: "main", commit: sha(1), shots: spec(white) });
  const build = await upload(ctx, {
    branch: "work",
    commit: sha(2),
    mergeBase: sha(1),
    ancestors: [sha(1)],
    shots: spec(changed),
  });
  const view = await buildView(ctx.db, ctx.projectId, build.id);
  const html = await renderRouted(
    <BuildSummary
      projectId={ctx.projectId}
      build={view.build}
      snapshots={view.snapshots}
      modelConfigured={modelConfigured}
      pending={false}
    />,
  );
  return { html, status: view.build.status, text: textOf(html) };
}

const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

describe("a summary the model did not write", () => {
  test("a build with 10 changed shots gets no summary, says why, and offers no Regenerate", async () => {
    const { html, text } = await changedBuild(10, true);
    expect(text).toContain(
      "No AI summary: 10 changed shots (summaries are made for builds with fewer than 10).",
    );
    expect(has(html, "summary-too-many")).toBe(true);
    for (const id of ["summary-skip", "summary-sentence", "summary-regenerate"])
      expect(has(html, id)).toBe(false);
  });

  test("a build under the limit still gets a summary slot: 9 changed shots are not told 'no summary'", async () => {
    const { html } = await changedBuild(9, true);
    expect(has(html, "summary-too-many")).toBe(false);
    expect(has(html, "summary-regenerate")).toBe(true);
  });

  test("with no model a changed shot is plain pixels: the summary says skip, and offers nothing to regenerate", async () => {
    const { html, status } = await changedBuild(1, false);
    expect(status).toBe("changes");
    expect(/data-testid="summary-skip"[^>]*>([^<]*)</.exec(html)?.[1]).toBe("skip: no judge.");
    expect(has(html, "summary-sentence")).toBe(false);
    expect(has(html, "summary-regenerate")).toBe(false);
  });
});
