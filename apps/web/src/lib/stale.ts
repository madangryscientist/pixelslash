// Stale twins (PS-297): pure words and shapes, so the query, the API and the screens say the same
// thing; `db/stale.ts` is the one that decides.

/** The web change that made native twins stale: the accepted shot, its build, who and when. */
export type StaleCause = {
  snapshotId: string;
  buildId: string;
  projectId: string;
  projectName: string;
  /** Who accepted the change: their name, else their login. Null when the user is gone. */
  acceptedBy: string | null;
  acceptedAt: Date;
};

/** The native platforms a key can be stale on. */
export type StalePlatform = "android" | "ios";

/** One native shot of a stale key: where a reviewer goes to accept it. */
export type StaleShot = {
  snapshotId: string;
  buildId: string;
  projectId: string;
  device: string;
  viewport: string;
};

/** One stale twin: a key (name + theme) on one native platform, and the web change behind it. */
export type StaleItem = {
  name: string;
  theme: string;
  platform: StalePlatform;
  cause: StaleCause;
  /** The newest native shot per device and viewport of the key on the platform. */
  shots: StaleShot[];
};

/** The day a change was accepted, as `2026-11-03` (UTC): the sentence and the CLI name a date, not a time. */
export const staleDate = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * `Button/md-primary dark on android is stale: web changed in build <ref>, accepted by Ada 2026-11-03`
 * in two halves with the build between them, so a screen can put a link there and the API a plain id.
 */
export function staleParts(item: Pick<StaleItem, "name" | "theme" | "platform" | "cause">): {
  before: string;
  after: string;
} {
  const { cause } = item;
  return {
    before: `${item.name} ${item.theme} on ${item.platform} is stale: web changed in build `,
    after: `, accepted by ${cause.acceptedBy ?? "someone"} ${staleDate(cause.acceptedAt)}`,
  };
}

/** The sentence with `buildRef` (an id, a short id, a URL) as the build. */
export function staleLine(
  item: Pick<StaleItem, "name" | "theme" | "platform" | "cause">,
  buildRef: string,
): string {
  const { before, after } = staleParts(item);
  return `${before}${buildRef}${after}`;
}
