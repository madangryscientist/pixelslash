import { resolve } from "node:path";
import { BRIEF_LIMIT, UsageError, briefTooLong, trimBrief } from "@slashsuite/pixelslash-engine";

/**
 * `--brief FILE` or `--brief-text TEXT`, trimmed: the author's words, refused here when over the
 * limit, so no build is opened for a brief the server would refuse. Undefined when neither is given.
 */
export async function readBrief(
  file: string | undefined,
  given: string | undefined,
  cwd: string,
): Promise<string | undefined> {
  if (file !== undefined && given !== undefined)
    throw new UsageError("give --brief FILE or --brief-text TEXT, not both");
  let raw = given;
  if (file !== undefined) {
    const at = Bun.file(resolve(cwd, file));
    if (!(await at.exists())) throw new UsageError(`--brief: no such file: ${file}`);
    raw = await at.text();
  }
  if (raw === undefined) return undefined;
  const brief = trimBrief(raw);
  if (brief && brief.length > BRIEF_LIMIT) throw new UsageError(briefTooLong(brief.length));
  return brief ?? undefined;
}
