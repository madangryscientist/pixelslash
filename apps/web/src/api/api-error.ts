import { BuildFinalisedError, ImageUnknownError, SnapshotCountError } from "#/db/builds";
import { NotFoundError } from "#/db/db";
import { NoRecoveryError } from "#/diff/process";
import { reportError } from "#/server/sentry";
import { Unprocessable } from "./errors";
import { API_VERSION } from "./read";
import { MAX_PNG_BYTES, TooLarge } from "./snapshot-form";
import { BadRequest, Forbidden } from "./validate";

const json = (body: unknown, status = 200) => Response.json(body, { status });

type ApiError = { status: number; code: string; message: string };

export function errorOf(e: unknown): ApiError {
  if (e instanceof BadRequest) return { status: 400, code: "bad_request", message: e.message };
  if (e instanceof NotFoundError) return { status: 404, code: "not_found", message: e.message };
  if (e instanceof Forbidden) return { status: 403, code: "forbidden", message: e.message };
  if (e instanceof Unprocessable) return { status: 422, code: "unprocessable", message: e.message };
  if (e instanceof ImageUnknownError) return { status: 409, code: e.code, message: e.message };
  if (
    e instanceof BuildFinalisedError ||
    e instanceof SnapshotCountError ||
    e instanceof NoRecoveryError
  )
    return { status: 409, code: "conflict", message: e.message };
  if (e instanceof TooLarge)
    return { status: 413, code: "too_large", message: `PNG over ${MAX_PNG_BYTES} bytes` };
  // Not one of the refusals above: a failed upload or finalise, which is the server's fault (PS-227).
  reportError(e, { area: "api" });
  throw e;
}

/**
 * An upload endpoint's error is the string it always was; every other carries a code. An upload
 * error the CLI acts on adds `code` beside the string (`ImageUnknownError.CODE`), which is additive.
 */
export function failWith(upload: boolean, { status, code, message }: ApiError): Response {
  if (upload)
    return json({ error: message, ...(code === ImageUnknownError.CODE ? { code } : {}) }, status);
  return json({ api_version: API_VERSION, error: { code, message } }, status);
}
