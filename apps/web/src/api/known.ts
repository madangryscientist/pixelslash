import { heldImages } from "#/db/held-images";
import type { Db } from "#/db/db";
import { parseKnown } from "./validate-known";

/**
 * Which of the hashes in a `/known` body the project already holds (PS-424): the ones a shot may
 * name instead of sending its PNG. Only the project's own finished builds count (`heldImages`).
 */
export async function knownImages(
  db: Db,
  projectId: string,
  body: unknown,
): Promise<{ known: string[] }> {
  const hashes = parseKnown(body);
  const held = await heldImages(db, projectId, hashes);
  return { known: hashes.filter((h) => held.has(h)) };
}
