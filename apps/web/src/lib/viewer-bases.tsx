import type { ReactNode } from "react";
import type { BaselineBuild } from "#/db/baseline-build";
import type { DiffResult, DiffStatus } from "#/db/schema";

/**
 * What the viewer's left pane is, said honestly. A shot is compared first with the previous build of
 * its branch (a carried or unchanged shot is identical to it), and separately with main
 * (`main_diff_*`, measured at upload). The pane shows main only when main's baseline is what the
 * shot was compared with; otherwise it names the earlier build, and, when the shot differs from main,
 * offers main as the other side to look at. Nothing is measured here: the boxes come from the stored
 * result of whichever comparison is chosen (invariant 1).
 */

export type BaseId = "main" | "build";

/** How the left side is named in the pane label, the slider and the images' alt text. */
export type BaseNames = { pane: ReactNode; short: string; alt: string };

export const MAIN_NAMES: BaseNames = { pane: "Main (baseline)", short: "Main", alt: "on main" };

/** One pair to look at: the left image, the stored result that measured it against the branch shot. */
export type Base = {
  id: BaseId;
  /** The switch's option. */
  switchLabel: string;
  names: BaseNames;
  mainUrl: string | null;
  diffUrl: string | null;
  result: DiffResult | null;
  /** The reviewer opened on main to decide a carried change, so the boxes are there without asking. */
  boxesByDefault: boolean;
  /** What was measured, in a line; null when nothing was. */
  summary: string | null;
};

export type Bases = {
  /** One option, or two when the shot differs from main and its first baseline is not main's. */
  options: Base[];
  initial: BaseId;
  /** Why there is no switch, when that is worth a line: not measured against main, or identical to it. */
  note: string | null;
};

export type BasesInput = {
  /** The branch the shot was uploaded on. */
  branch: string;
  baselineBuild: BaselineBuild | null;
  snapshot: {
    carriedFrom: string | null;
    diffResult: DiffResult | null;
    mainDiffStatus: DiffStatus | null;
    mainDiffResult: DiffResult | null;
  };
  images: { main: string | null; mainBaseline: string | null; diff: string | null };
};

const short = (sha: string) => sha.slice(0, 7);

export type Format = {
  number: (n: number) => string;
  percent: (part: number, area: number) => string;
};

/** What a stored result measured, in a line; null when nothing was. */
function summaryOf(
  result: DiffResult | null,
  status: DiffStatus | null,
  format: Format,
): string | null {
  if (status === "new" && !result) return "New against main: main has no such shot.";
  if (!result) return null;
  if (result.settledBy) return "No change: identical bytes, not diffed.";
  const regions = result.regions.filter((region) => region.kind === "change").length;
  const px = format.number(result.changedPixels);
  const share = format.percent(result.changedPixels, result.width * result.height);
  return `${px} changed px (${share}) in ${regions} ${regions === 1 ? "region" : "regions"}`;
}

/** A link to the earlier build's shot, or its plain label when the caller cannot link. */
export type BuildLink = (build: BaselineBuild, text: string) => ReactNode;

function earlierNames(
  build: BaselineBuild,
  branch: string,
  link: BuildLink | undefined,
): BaseNames {
  const where =
    build.branch === branch ? "Earlier build on this branch" : `Build on ${build.branch}`;
  const sha = short(build.commitSha);
  return {
    pane: (
      <>
        {where} {link ? link(build, sha) : sha}
      </>
    ),
    short: `Build ${sha}`,
    alt: "on the earlier build",
  };
}

export function basesOf(input: BasesInput, format: Format, link?: BuildLink): Bases {
  const { snapshot, images, baselineBuild: build } = input;
  const first: Base = {
    id: "main",
    switchLabel: "Against main",
    names: MAIN_NAMES,
    mainUrl: images.main,
    diffUrl: images.diff,
    result: snapshot.diffResult,
    boxesByDefault: false,
    summary: null,
  };
  // Main's own baseline (or no baseline at all): the pane says what it always said.
  if (!build || build.isDefaultBranch) return { options: [first], initial: "main", note: null };

  const earlier: Base = {
    ...first,
    id: "build",
    switchLabel: `Against build ${short(build.commitSha)}`,
    names: earlierNames(build, input.branch, link),
    summary: summaryOf(snapshot.diffResult, null, format),
  };
  const status = snapshot.mainDiffStatus;
  if (status === null)
    return {
      options: [earlier],
      initial: "build",
      note: "This shot was not measured against main.",
    };
  if (status === "unchanged")
    return {
      options: [earlier],
      initial: "build",
      note: "Identical to main's baseline.",
    };
  const carried = snapshot.carriedFrom !== null;
  const main: Base = {
    ...first,
    mainUrl: images.mainBaseline,
    // No diff image is stored against main; the boxes are drawn from the stored result.
    diffUrl: null,
    result: snapshot.mainDiffResult,
    boxesByDefault: carried,
    summary: summaryOf(snapshot.mainDiffResult, status, format),
  };
  return { options: [main, earlier], initial: carried ? "main" : "build", note: null };
}

/** The option chosen, else the one the viewer opens on; a choice made on another shot is ignored. */
export function chosenBase(bases: Bases, chosen: BaseId | null): Base {
  const [first] = bases.options;
  if (!first) throw new Error("a shot always has one comparison");
  const find = (id: BaseId) => bases.options.find((option) => option.id === id);
  return (chosen && find(chosen)) || find(bases.initial) || first;
}
