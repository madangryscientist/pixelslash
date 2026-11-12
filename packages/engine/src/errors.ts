/** Bad flags or missing inputs. The CLI prints usage and exits 2. */
export class UsageError extends Error {}
/** A page could not be captured (down URL, HTTP error, never settled). Exit 1. */
export class CaptureError extends Error {}
/** A `pixelslash dev` session lock could not be taken and no other session holds it (PS-393). Exit 1. */
export class DevLockError extends Error {}
/** The Figma API refused or returned nothing usable. Exit 1. */
export class FigmaError extends Error {}
/** The server refused an upload, was unreachable, or the checkout could not be read. Exit 1. */
export class UploadError extends Error {
  /** The HTTP status of the server's answer, when it gave one (PS-424). */
  status: number | undefined;
  /** The API's error `code`, when its answer carried one (PS-424): `image_unknown`. */
  code: string | undefined;

  constructor(message: string, answer: { status?: number; code?: string } = {}) {
    super(message);
    this.status = answer.status;
    this.code = answer.code;
  }
}
