import { BRIEF_LIMIT, briefTooLong, trimBrief } from "@hackcove/pixelslash-engine/brief";
import { bad, Unprocessable } from "./errors";

/** The uploader's brief (PS-232): absent or blank is none; trimmed; over `BRIEF_LIMIT` is a 422. */
export function brief(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string") bad("brief", "must be a string");
  const trimmed = trimBrief(v);
  if (trimmed && trimmed.length > BRIEF_LIMIT)
    throw new Unprocessable(briefTooLong(trimmed.length));
  return trimmed;
}
