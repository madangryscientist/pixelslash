/**
 * The author's brief (PS-232): their own words on what a build meant to change, sent with
 * `upload --brief`. The server stores it, the build's summary reads it against what was measured,
 * and nothing decides anything by it. Client-safe: the CLI, the API and the summary share it.
 */

/** The longest brief the CLI sends and the API takes, in characters, once trimmed. */
export const BRIEF_LIMIT = 4000;

/** The brief as it is stored: trimmed, or null when nothing is left. */
export function trimBrief(raw: string): string | null {
  const brief = raw.trim();
  return brief === "" ? null : brief;
}

/** Why a brief is refused, naming the limit. */
export const briefTooLong = (length: number) =>
  `brief is ${length} characters; the limit is ${BRIEF_LIMIT}`;
