import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { HomePage } from "#/components/pages/home";
import { Footer } from "#/components/shell";
import { STAGE, STAGES } from "./stage.ts";

const stage = STAGES[STAGE];

/** The markup inside the element carrying `testId`, so a word elsewhere on the page cannot pass it. */
function inner(markup: string, testId: string): string {
  const match = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>(.*?)</[a-z]+>`, "s").exec(
    markup,
  );
  expect(match, `no element with data-testid="${testId}"`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("the release stage", () => {
  test("PixelSlash is in alpha", () => {
    expect(STAGE).toBe("alpha");
  });

  test("the home page says the stage, and what it means, under the lede", () => {
    const line = inner(renderToStaticMarkup(<HomePage />), "stage");
    expect(line).toContain(stage.label);
    expect(line).toContain(stage.sentence);
  });

  test("the footer says it too, because the footer is on every page", () => {
    const line = inner(renderToStaticMarkup(<Footer />), "stage-footer");
    expect(line).toContain(stage.label);
    expect(line).toContain(stage.sentence);
  });
});
