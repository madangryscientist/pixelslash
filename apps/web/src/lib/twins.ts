import { PLATFORMS, type Platform } from "../../../../packages/engine/src/native.ts";
import type { StaleCause } from "./stale";

// Twin snapshots (PS-295): the same name and theme on another platform. Pure words and shapes, so
// the db query, the API and the screens say the same thing; `db/twins.ts` is the one that pairs.

export { PLATFORMS, type Platform };

/** The words a person uses for a stored platform: `web` for the pinned `linux` (and anything not native). */
export function platformOfServer(stored: string): Platform {
  return stored === "android" || stored === "ios" ? stored : "web";
}

/** Where a twin was found: the build itself, the twin project's build at the same commit, or the current baselines. */
export type TwinSource =
  | { kind: "build"; commitSha: null }
  | { kind: "commit"; commitSha: string }
  | { kind: "baselines"; commitSha: null };

/** `same build`, `same commit 1a2b3c4` or `baselines`: the source as the CLI and the screens name it. */
export function twinSourceLabel(source: TwinSource): string {
  if (source.kind === "build") return "same build";
  if (source.kind === "commit") return `same commit ${source.commitSha.slice(0, 7)}`;
  return "baselines";
}

/** One shot on the other side of a key. */
export type Twin = {
  snapshotId: string;
  platform: Platform;
  /** The device label of a native shot; null for web. */
  device: string | null;
  viewport: string;
  projectId: string;
  projectName: string;
  buildId: string;
  source: TwinSource;
  /** Whether this shot came with a layout metrics file (PS-294). */
  hasMetrics: boolean;
  /** The web change that made this native shot's key stale (PS-297); null when it is not stale. */
  stale: StaleCause | null;
};

/** One shot of the build, with the twins the other platforms hold for its key (name + theme). */
export type TwinEntry = {
  snapshotId: string;
  name: string;
  theme: string;
  platform: Platform;
  device: string | null;
  viewport: string;
  hasMetrics: boolean;
  /** Set on a native shot whose own key is stale (PS-297): the web change behind it. */
  stale: StaleCause | null;
  /** Every shot of every other platform under the key, several viewports or devices included. */
  twins: Twin[];
  /** The platforms in play that hold no shot under the key. Empty on a linked entry. */
  missing: Platform[];
};

export type BuildTwins = {
  /** The project named as the twin, when the build's project links one in its own org. */
  twinProject: { id: string; name: string } | null;
  /** Shots with a twin on every platform in play. */
  linked: TwinEntry[];
  /** Shots that miss at least one platform in play; a partly linked shot lists its twins as well. */
  unlinked: TwinEntry[];
};

/** A build with no twin to speak of: no platform other than the build's own is in play. */
export const noTwins = (twinProject: BuildTwins["twinProject"] = null): BuildTwins => ({
  twinProject,
  linked: [],
  unlinked: [],
});

/** The entry of one shot of the build, linked or not; null when no other platform is in play. */
export const twinEntryOf = (t: BuildTwins, snapshotId: string): TwinEntry | null =>
  [...t.linked, ...t.unlinked].find((e) => e.snapshotId === snapshotId) ?? null;

export const hasTwins = (t: BuildTwins): boolean => t.linked.length + t.unlinked.length > 0;

/** `android · Pixel 8 API 35`, or `web`: a twin or shot as a link or a line names it. */
export function twinLabel(t: { platform: Platform; device: string | null }): string {
  return t.device ? `${t.platform} · ${t.device}` : t.platform;
}

/** `Button/loading dark has no android twin`: one unlinked shot, in the CLI's words and the page's. */
export function unlinkedLine(e: Pick<TwinEntry, "name" | "theme" | "missing">): string {
  return `${e.name} ${e.theme} has no ${e.missing.join(" or ")} twin`;
}
