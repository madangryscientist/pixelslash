import { bad } from "./errors";
import { object } from "./validate";

/** What `/known` and a by-hash upload take (PS-424). */

/** A sha256 as the API takes it: 64 lowercase hex characters. */
export const SHA256 = /^[0-9a-f]{64}$/;
/** Hashes one `/known` call may ask about; the client sends a longer list in parts. */
export const MAX_KNOWN = 1000;

/** The body of `/known`: `{ "sha256": [hex, ...] }`, at most MAX_KNOWN, each asked once. */
export function parseKnown(raw: unknown): string[] {
  const list = object(raw, "body").sha256;
  if (!Array.isArray(list) || list.length > MAX_KNOWN)
    bad("sha256", `must be an array of at most ${MAX_KNOWN} hashes`);
  const hashes: string[] = [];
  for (const [i, h] of list.entries()) {
    if (typeof h !== "string" || !SHA256.test(h))
      bad(`sha256[${i}]`, "must be 64 lowercase hex characters");
    hashes.push(h);
  }
  return [...new Set(hashes)];
}
