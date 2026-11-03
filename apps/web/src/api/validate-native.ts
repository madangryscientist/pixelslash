import { DEVICE_LABEL, WEB_SERVER_PLATFORM } from "../../../../packages/engine/src/native.ts";
import { bad } from "./errors";

// Native snapshots (PS-293). The server keeps the device label in the browser column, so a web key
// is validated exactly as it always was and only a non-web platform takes a device label.

const TOKEN = /^[\w.-]+$/;
const SCALE = /^\d+(\.\d+)?$/;

function label(v: unknown, where: string, max: number, pattern?: RegExp): string {
  if (typeof v !== "string" || v === "" || v.length > max)
    bad(where, `must be a non-empty string of at most ${max} characters`);
  if (pattern && !pattern.test(v)) bad(where, "has characters it may not use");
  return v;
}

/**
 * The key's `platform` and `browser`: a token for web, a device label (spaces allowed) in `browser`
 * for android and ios. `at` prefixes each field's name in an error.
 */
export function platformAndBrowser(m: Record<string, unknown>, at: string) {
  const platform = label(m.platform, `${at}platform`, 40, TOKEN);
  const web = platform === WEB_SERVER_PLATFORM;
  const browser = label(m.browser, `${at}browser`, web ? 40 : 80, web ? TOKEN : DEVICE_LABEL);
  return { platform, browser };
}

/** The fingerprint; a web upload sends no native fields, so its stored fingerprint is as it was. */
export function fingerprint(fp: Record<string, unknown>) {
  return {
    image: label(fp.image, "fingerprint.image", 300),
    browser: label(fp.browser, "fingerprint.browser", 300),
    fonts: label(fp.fonts, "fingerprint.fonts", 300),
    ...(fp.platform !== undefined && {
      platform: label(fp.platform, "fingerprint.platform", 40, TOKEN),
    }),
    ...(fp.device !== undefined && {
      device: label(fp.device, "fingerprint.device", 80, DEVICE_LABEL),
    }),
    ...(fp.scale !== undefined && { scale: label(fp.scale, "fingerprint.scale", 12, SCALE) }),
  };
}
