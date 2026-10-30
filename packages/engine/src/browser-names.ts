/** The browsers the pinned capture image ships. A variant naming another is a usage error. */
export const IMAGE_BROWSERS = ["chromium", "firefox", "webkit"] as const;
export type BrowserName = (typeof IMAGE_BROWSERS)[number];

export function isBrowserName(v: unknown): v is BrowserName {
  return IMAGE_BROWSERS.some((b) => b === v);
}
