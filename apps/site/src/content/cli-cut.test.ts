import { describe, expect, test } from "vitest";
import { ANCHOR_PAGE } from "virtual:cli-meta";
import { CLI_INTRO_DOC } from "./cli-intro.ts";
import { CLI_SPLIT } from "./cli-split.ts";
import { loadDoc } from "./docs.ts";

/*
 * What the build cuts from docs/cli.md (`cli-meta.ts`) is the split of the file, unchanged: each cli
 * page's slice lexes to the very blocks the split gives that page, with the same anchors.
 */
describe("the build's cut of cli.md", () => {
  test("the anchor map and the index lead", () => {
    expect(ANCHOR_PAGE).toEqual(Object.fromEntries(CLI_SPLIT.anchorPage));
    expect(JSON.stringify(CLI_INTRO_DOC.tokens)).toBe(JSON.stringify(CLI_SPLIT.preamble));
  });

  test.each([...CLI_SPLIT.pages])("the %s page", async (slug, blocks) => {
    const doc = await loadDoc(slug);
    expect(JSON.stringify(doc.tokens)).toBe(JSON.stringify(blocks));
    const ids = blocks.flatMap((block) =>
      block.type === "heading" ? [CLI_SPLIT.ids.get(block)] : [],
    );
    expect(doc.headings.map((heading) => heading.id)).toEqual(ids);
  });
});
