import { describe, expect, test } from "vitest";
import { shotChips, shotLabeller, titleWords, variantChips } from "./shot-label";

const NAMES = [
  "ui-callout-tones@theme=default",
  "ui-callout-tones@theme=catppuccin-mocha",
  "ui-callout-with-title@theme=default",
  "ui-button-variants@theme=default",
  "ui-button-as-link@theme=default",
  "overview-all-themes@theme=default",
  "solo",
];

describe("shotLabeller", () => {
  const label = shotLabeller(NAMES);

  test("the component is the prefix another story shares, the story is the rest", () => {
    expect(label("ui-callout-with-title@theme=default")).toMatchObject({
      component: "Ui callout",
      story: "With title",
    });
    expect(label("ui-button-as-link@theme=default")).toMatchObject({
      component: "Ui button",
      story: "As link",
    });
  });

  test("the globals become variants, in order, and the same story in two themes reads the same", () => {
    const mocha = label("ui-callout-tones@theme=catppuccin-mocha");
    expect(mocha.variants).toEqual([{ key: "theme", value: "catppuccin-mocha" }]);
    expect(mocha.story).toBe(label("ui-callout-tones@theme=default").story);
  });

  test("a name that shares nothing with another is shown whole, not split on a guess", () => {
    expect(label("solo")).toEqual({ component: null, story: "Solo", variants: [] });
    expect(label("overview-all-themes@theme=default")).toMatchObject({
      component: null,
      story: "Overview all themes",
    });
  });

  test("a name with no globals has no variants", () => {
    expect(shotLabeller(["about", "about-us"])("about").variants).toEqual([]);
  });
});

describe("titleWords", () => {
  test("hyphens become spaces and each word is capitalised", () => {
    expect(titleWords("thrifty-paper")).toBe("Thrifty Paper");
    expect(titleWords("default")).toBe("Default");
  });
});

describe("shotChips", () => {
  const label = shotLabeller([
    "overview-gallery@theme=catppuccin-mocha",
    "overview-gallery@theme=default",
    "solo",
  ]);
  const column = { theme: "light", viewport: "1280x720" };

  test("two shots that differ only by @theme= get different chips, whatever the column says", () => {
    const mocha = shotChips(column, label("overview-gallery@theme=catppuccin-mocha"));
    const plain = shotChips(column, label("overview-gallery@theme=default"));
    expect(mocha).toEqual(["Catppuccin Mocha", "1280x720"]);
    expect(plain).toEqual(["Default", "1280x720"]);
  });

  test("the column's scheme is shown only when the name carries no theme", () => {
    expect(shotChips({ theme: "dark", viewport: "1280x720" }, label("solo"))).toEqual([
      "Dark",
      "1280x720",
    ]);
  });
});

describe("variantChips", () => {
  const label = shotLabeller(["ui-callout-tones@theme=catppuccin-mocha@density=compact", "solo"]);

  test("the name's own theme, then its other globals", () => {
    expect(variantChips(label("ui-callout-tones@theme=catppuccin-mocha@density=compact"))).toEqual([
      "Catppuccin Mocha",
      "Density: Compact",
    ]);
  });

  test("a name with no theme gets no theme chip: the colour scheme is never one", () => {
    expect(variantChips(label("solo"))).toEqual([]);
  });
});
