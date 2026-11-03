import type { SnapshotEntry } from "./snapshot.ts";

// Native screenshots (PS-293): Maestro on an Android emulator or an iOS Simulator. The user-facing
// words are `web | android | ios`; the server keeps `linux` for web, so no row, baseline or manifest
// of a web project changes. This file is the one place that maps between the two, and it imports
// only a type, because `snapshot-paths.ts` (the Playwright helper's bundle) uses it.

export const PLATFORMS = ["web", "android", "ios"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type NativePlatform = Exclude<Platform, "web">;

/** What the server stores as `platform` for web: the pinned capture image is Linux. */
export const WEB_SERVER_PLATFORM = "linux";

export function isPlatform(v: unknown): v is Platform {
  return PLATFORMS.some((p) => p === v);
}

export function isNativePlatform(v: unknown): v is NativePlatform {
  return v === "android" || v === "ios";
}

/** A device label the server keeps in its browser column: letters, digits, spaces and `_.()+,:/-`, up to 80. */
export const DEVICE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} _.()+,:/-]{0,79}$/u;

/** The native fields of an entry; all three are absent on a web entry, as in every manifest before PS-293. */
export type NativeFields = { platform?: NativePlatform; device?: string; scale?: number };

/** The `platform` the server stores: `linux` for web, else the native platform. */
export function serverPlatform(e: Pick<SnapshotEntry, "platform">): string {
  return e.platform ?? WEB_SERVER_PLATFORM;
}

/**
 * The `browser` the server stores. For a native snapshot the device is the renderer, so the device
 * label sits in the browser column and the unique key stays as it is.
 */
export function serverBrowser(e: Pick<SnapshotEntry, "platform" | "device" | "variant">): string {
  return e.platform && e.device ? e.device : e.variant.browser;
}

/** `chromium`, or `android · Pixel 8 API 35`: what rendered a shot, for a label a person reads. */
export function rendererLabel(e: Pick<SnapshotEntry, "platform" | "device" | "variant">): string {
  return e.platform && e.device ? `${e.platform} · ${e.device}` : e.variant.browser;
}

/** The same label from a server key (`platform` is `linux` or native, `browser` the device for native). */
export function keyRendererLabel(k: { platform?: string | undefined; browser: string }): string {
  return k.platform && k.platform !== WEB_SERVER_PLATFORM
    ? `${k.platform} · ${k.browser}`
    : k.browser;
}

/** The pixel size a native shot's PNG should have: the logical viewport times the device pixel ratio. */
export function expectedPixels(
  viewport: { width: number; height: number },
  scale: number,
): { width: number; height: number } {
  return { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
}
