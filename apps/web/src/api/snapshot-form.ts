import type { DiffLocation } from "#/db/schema";
import { flakeFields } from "./flakes";
import { SHA256 } from "./validate-known";
import { METRICS_PART_ALLOWANCE, checkMetricsBytes } from "./validate-metrics";
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
 * The optional `metrics` part (PS-294): the layout metrics file, checked. A file over the cap is
 * refused before it is read; a malformed one is a 400. Absent is null.
 */
async function metricsPart(form: FormData): Promise<ArrayBuffer | null> {
  const file = form.get("metrics");
  if (file === null) return null;
  if (!(file instanceof File)) throw new BadRequest("metrics must be a file upload");
  if (file.size > METRICS_PART_ALLOWANCE) throw new TooLarge();
  const bytes = await file.arrayBuffer();
  checkMetricsBytes(bytes);
  return bytes;
}

/**
 * The shot's image: its `file` part, or, with no `file`, the hash in `meta.sha256` of an image the
 * project already holds (PS-424). A shot that sends its file is stored from those bytes alone; a
 * `meta.sha256` beside them is not read.
 */
async function imagePart(form: FormData, fields: Record<string, unknown>) {
  if (form.get("file") === null && fields.sha256 !== undefined) {
    if (typeof fields.sha256 !== "string" || !SHA256.test(fields.sha256))
      throw new BadRequest("sha256 must be 64 lowercase hex characters");
    return { sha256: fields.sha256 };
  }
  return pngPart(form, "file");
}

/**
 * Multipart: `meta` (JSON) and `file` (the PNG), and optionally `metrics` (PS-294). In a `ci` project `meta.ci` carries the CLI's
 * results, and each needs its diff mask as `diff:<baselineId>`; the shot, plus at most two masks.
 * A flaky shot (ob 1737) adds `meta.flake` and its re-captures as `flake:<run>`, at most
 * MAX_FLAKE_RUNS - 1 of them; `meta.flaky` is the shot's policy (ob 1724). A shot whose PNG the
 * project already holds may leave out `file` and name it as `meta.sha256` (PS-424); every other
 * part is read as for any shot.
 */
export async function snapshotForm(request: Request, project: { diffLocation: DiffLocation }) {
  const pngs = (project.diffLocation === "ci" ? 3 : 1) + MAX_FLAKE_RUNS - 1;
  if (
    Number(request.headers.get("content-length")) >
    pngs * MAX_PNG_BYTES + METRICS_PART_ALLOWANCE + 64 * 1024
  )
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
  const png = await imagePart(form, fields);
  const metrics = await metricsPart(form);
  // A server project measures at finalise: results sent to it are not stored, so none is trusted.
  const sent = project.diffLocation === "ci" ? parseCiInput(fields.ci) : null;
  if (!sent) return { input, png, metrics, ci: null, flake };
  const results = await Promise.all(
    sent.results.map(async (r) => ({ ...r, mask: await pngPart(form, `diff:${r.baselineId}`) })),
  );
  // A shot sent by hash has no bytes here: the held image's size is read when it is stored.
  const image = png instanceof ArrayBuffer ? pngSize(png) : null;
  return {
    input,
    png,
    metrics,
    ci: { engineVersion: sent.engineVersion, image, results },
    flake,
  };
}

export class TooLarge extends Error {}
