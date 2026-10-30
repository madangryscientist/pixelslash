import type { DiffLocation } from "#/db/schema";
import { flakeFields } from "./flakes";
import {
  BadRequest,
  MAX_FLAKE_RUNS,
  isPng,
  object,
  parseCiInput,
  parseSnapshotInput,
  pngSize,
} from "./validate";

/** A PNG over this is refused before it is read; a full-page shot is a few MB. */
export const MAX_PNG_BYTES = 32 * 1024 * 1024;

/** One part of a snapshot upload: a PNG no larger than MAX_PNG_BYTES. */
async function pngPart(form: FormData, field: string): Promise<ArrayBuffer> {
  const file = form.get(field);
  if (!(file instanceof File)) throw new BadRequest(`${field} must be a PNG upload`);
  if (file.size > MAX_PNG_BYTES) throw new TooLarge();
  const png = await file.arrayBuffer();
  if (!isPng(png)) throw new BadRequest(`${field} is not a PNG`);
  return png;
}

/**
 * Multipart: `meta` (JSON) and `file` (the PNG). In a `ci` project `meta.ci` carries the CLI's
 * results, and each needs its diff mask as `diff:<baselineId>`; the shot, plus at most two masks.
 * A flaky shot (ob 1737) adds `meta.flake` and its re-captures as `flake:<run>`, at most
 * MAX_FLAKE_RUNS - 1 of them; `meta.flaky` is the shot's policy (ob 1724).
 */
export async function snapshotForm(request: Request, project: { diffLocation: DiffLocation }) {
  const pngs = (project.diffLocation === "ci" ? 3 : 1) + MAX_FLAKE_RUNS - 1;
  if (Number(request.headers.get("content-length")) > pngs * MAX_PNG_BYTES + 64 * 1024)
    throw new TooLarge();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new BadRequest("body must be multipart/form-data");
  }
  const meta = form.get("meta");
  if (typeof meta !== "string") throw new BadRequest("meta must be a JSON field");
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    throw new BadRequest("meta must be JSON");
  }
  const fields = object(parsed, "meta");
  const { flaky, flake } = await flakeFields(form, fields, MAX_PNG_BYTES);
  const input = { ...parseSnapshotInput(parsed), flaky };
  const png = await pngPart(form, "file");
  // A server project measures at finalise: results sent to it are not stored, so none is trusted.
  const sent = project.diffLocation === "ci" ? parseCiInput(fields.ci) : null;
  if (!sent) return { input, png, ci: null, flake };
  const results = await Promise.all(
    sent.results.map(async (r) => ({ ...r, mask: await pngPart(form, `diff:${r.baselineId}`) })),
  );
  const image = pngSize(png);
  return { input, png, ci: { engineVersion: sent.engineVersion, image, results }, flake };
}

export class TooLarge extends Error {}
