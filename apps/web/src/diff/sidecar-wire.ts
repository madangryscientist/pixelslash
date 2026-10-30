import { Buffer } from "node:buffer";
import type { DiffIgnore, DiffOptions, PixelDiff } from "@pixelslash/engine/diff";

/**
 * The diff sidecar's wire format (PS-203), shared by the Worker's client (`sidecar.ts`) and the
 * Bun sidecar (`deploy/ssh/diff-sidecar.ts`). Pure byte framing, no codec: the PNGs go as they were
 * uploaded and the overlay comes back as PNG bytes, so nothing is base64'd and nothing is decoded
 * twice.
 *
 * Request:  u32 json length, json `{ options, ignore }`, u32 main length, main PNG, branch PNG.
 * Response: u32 json length, json (the `PixelDiff` without `overlay`, plus `overlay: boolean`), the
 * overlay PNG when there is one.
 */

export const SIDECAR_PATH = "/v1/diff";

type SidecarRequest = {
  main: Buffer;
  branch: Buffer;
  options: DiffOptions;
  ignore: DiffIgnore;
};

type Parts = { head: unknown; rest: Buffer };

/**
 * Decoded JSON is checked for shape, not trusted for it. The options and ignore areas are the
 * engine's to read, as they are when the Worker calls `diffPngs` itself; the reply is checked for
 * every field the Worker stores.
 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const NUMBERS = [
  "ignoredPixels",
  "changedPixels",
  "antialiased",
  "width",
  "height",
  "mainWidth",
  "mainHeight",
  "branchWidth",
  "branchHeight",
] as const;
const isResult = (value: unknown): value is Omit<PixelDiff, "overlay"> & { overlay: boolean } =>
  isObject(value) &&
  typeof value["changed"] === "boolean" &&
  typeof value["overlay"] === "boolean" &&
  NUMBERS.every((key) => typeof value[key] === "number") &&
  Array.isArray(value["regions"]) &&
  Array.isArray(value["ignored"]) &&
  isObject(value["specks"]) &&
  typeof value["settledBy"] === "string";

function frame(json: unknown, ...tail: Buffer[]): Uint8Array<ArrayBuffer> {
  const head = Buffer.from(JSON.stringify(json));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(head.length);
  return Buffer.concat([length, head, ...tail]);
}

function unframe(bytes: Buffer): Parts {
  if (bytes.length < 4) throw new Error("sidecar frame is too short");
  const end = 4 + bytes.readUInt32BE(0);
  if (end > bytes.length) throw new Error("sidecar frame's head runs past its end");
  const head: unknown = JSON.parse(bytes.toString("utf8", 4, end));
  return { head, rest: bytes.subarray(end) };
}

export function encodeRequest({
  main,
  branch,
  options,
  ignore,
}: SidecarRequest): Uint8Array<ArrayBuffer> {
  const mainLength = Buffer.alloc(4);
  mainLength.writeUInt32BE(main.length);
  return frame({ options, ignore }, mainLength, main, branch);
}

export function decodeRequest(bytes: Buffer): SidecarRequest {
  const { head, rest } = unframe(bytes);
  if (rest.length < 4) throw new Error("sidecar request has no images");
  const mainEnd = 4 + rest.readUInt32BE(0);
  if (mainEnd > rest.length) throw new Error("sidecar request's main image runs past its end");
  const options = isObject(head) ? head["options"] : undefined;
  const ignore = isObject(head) ? head["ignore"] : undefined;
  return {
    options: isObject(options) ? options : {},
    ignore: isObject(ignore) ? ignore : {},
    main: rest.subarray(4, mainEnd),
    branch: rest.subarray(mainEnd),
  };
}

export function encodeResponse({ overlay, ...rest }: PixelDiff): Uint8Array<ArrayBuffer> {
  return overlay ? frame({ ...rest, overlay: true }, overlay) : frame({ ...rest, overlay: false });
}

export function decodeResponse(bytes: Buffer): PixelDiff {
  const { head, rest } = unframe(bytes);
  if (!isResult(head)) throw new Error("sidecar reply is not a diff result");
  const { overlay, ...fields } = head;
  return { ...fields, overlay: overlay ? rest : null };
}
