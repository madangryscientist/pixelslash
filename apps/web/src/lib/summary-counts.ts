import { tabCounts } from "./build-tabs";
import { reviewGroupOf } from "./snapshot-groups";

type Shot = Parameters<typeof reviewGroupOf>[0] & {
  aiReview?: { regions: { label: string }[] } | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const DESCRIBED = new Set(["changed", "new", "removed"]);

/** Some shot changed, is new or is gone: there is something for the summary to describe. */
export const isDescribable = (shots: readonly { diffStatus: string | null }[]): boolean =>
  shots.some((shot) => DESCRIBED.has(shot.diffStatus ?? ""));

/**
 * What the page states from the measurements, beside the model's sentences: the model is never
 * asked about these, so a shot that was not measured is never read as unchanged.
 */
function measuredCounts(shots: Shot[]): string[] {
  const counts = tabCounts(shots);
  const carried = carriedFromMain(shots);
  const noise = shots
    .flatMap((shot) => shot.aiReview?.regions ?? [])
    .filter((note) => note.label === "noise").length;
  const parts = [`${counts.unchanged} unchanged`];
  if (carried.changed + carried.new > 0)
    parts.unshift(
      `${carried.changed} changed and ${carried.new} new carried from main: no change since the previous build, but they still differ from main`,
    );
  if (counts.unmeasured > 0)
    parts.push(
      `${plural(counts.unmeasured, "shot")} not measured: not compared, so not known to be unchanged`,
    );
  if (noise > 0) parts.push(`${plural(noise, "region")} labelled likely noise`);
  return parts;
}

/** Shots filed under changed or new only because they differ from main (PS-285), not because this build changed them. */
function carriedFromMain(shots: Shot[]): { changed: number; new: number } {
  const held = { changed: 0, new: 0 };
  for (const shot of shots) {
    const group = reviewGroupOf(shot);
    if (shot.carriedFrom !== null && (group === "changed" || group === "new")) held[group]++;
  }
  return held;
}

/** With a brief, nothing changed is still not a match: there was nothing to read against it. */
const nothingChanged = (brief: string | null) =>
  brief ? "Nothing changed, so there is nothing to read against the brief. " : "Nothing changed. ";

/** The line under the summary: the measured counts, led by "Nothing changed." when nothing did. */
export function summaryCounts(shots: Shot[], brief: string | null): string {
  const carried = carriedFromMain(shots);
  const lead =
    isDescribable(shots) || carried.changed + carried.new > 0 ? "" : nothingChanged(brief);
  return `${lead}${measuredCounts(shots).join(" · ")}.`;
}
