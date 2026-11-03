import type { CaptureSession, Shoot, SnapshotEntry } from "./snapshot.ts";

/** The shot a manifest entry names, again; `undefined` when the config has no such route or variant. */
export function recapture(
  session: CaptureSession,
  entry: Pick<SnapshotEntry, "name" | "variant">,
): Promise<Shoot | undefined> {
  const route = session.routes.find((r) => r.name === entry.name);
  // A baseline is only ever matched in its own browser: the same name in another is another shot.
  const variant = session.config.variants.find(
    (v) => v.name === entry.variant.name && v.browser === entry.variant.browser,
  );
  return route && variant ? session.shoot(route, variant) : Promise.resolve(undefined);
}
