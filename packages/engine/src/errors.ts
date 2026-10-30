/** Bad flags or missing inputs. The CLI prints usage and exits 2. */
export class UsageError extends Error {}
/** A page could not be captured (down URL, HTTP error, never settled). Exit 1. */
export class CaptureError extends Error {}
/** The Figma API refused or returned nothing usable. Exit 1. */
export class FigmaError extends Error {}
/** The server refused an upload, was unreachable, or the checkout could not be read. Exit 1. */
export class UploadError extends Error {}
