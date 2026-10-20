import { describe, expect, test } from "vitest";
import { captureSection } from "../src/capture-render.ts";
import { flagged, type CaptureStage, type PairOutcome } from "../src/capture-stage.ts";

const clean: PairOutcome = { kind: "diffed", changedPx: 0, regions: [], sizeMismatch: false };
const dirty: PairOutcome = {
  kind: "diffed",
  changedPx: 120,
  regions: [{ x: 10, y: 20, w: 30, h: 40 }],
  sizeMismatch: false,
};
const failed: PairOutcome = { kind: "failed", error: "capture settle exceeded 8000ms" };

const page = (name: string) => ({ name, noise: `${name} noise` });

function stage(image: PairOutcome[]): CaptureStage {
  return {
    imageVersion: "sha256:abc",
    rows: [
      { page: page("spinner"), arms: { image: [clean, clean], bare: [clean], control: [dirty] } },
      { page: page("ticker"), arms: { image, bare: [clean], control: [clean, clean] } },
    ],
  };
}

describe("flagged", () => {
  test("counts differing pairs, failed captures and size mismatches", () => {
    const resized: PairOutcome = { ...clean, sizeMismatch: true };
    expect(flagged([clean, dirty, failed, resized])).toBe(3);
  });
});

describe("captureSection", () => {
  test("says 0 false changes when the image is clean everywhere", () => {
    const text = captureSection(stage([clean, clean]));
    expect(text).toContain("The pinned image produced 0 false changes on every page.");
  });

  test("names a page the image flags, with where and why", () => {
    const text = captureSection(stage([clean, dirty]));
    expect(text).toContain("falsely flagged 1 of 2 pages");
    expect(text).toContain("**ticker**: 1/2 pairs differ; the diff covers 30x40 at 10,20");
    expect(text).toContain("ticker noise");
  });

  test("a failed capture is named as such", () => {
    const text = captureSection(stage([failed]));
    expect(text).toContain(
      "**ticker**: a capture failed in the image (capture settle exceeded 8000ms)",
    );
  });

  test("says which pages the control did not flag", () => {
    expect(captureSection(stage([clean]))).toContain("The control did not flag ticker");
  });
});
