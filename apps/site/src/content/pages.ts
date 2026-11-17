/**
 * Every page of the site. The build prerenders each one; the head of each page, the sitemap and the
 * smoke test read the same list. The marketing pages moved to slashslash.build (`moved.ts`); the nav
 * (`nav.ts`) links them around these, so it picks each of these by index: reorder both together.
 */
export const PAGES = [
  {
    to: "/docs",
    label: "Docs",
    title: "Docs · PixelSlash",
    description:
      "Install PixelSlash, run a first compare, then look up whatever you are doing next: capture, CI, the diff, the report and the API.",
  },
  {
    to: "/self-host",
    label: "Self-host",
    title: "Self-host · PixelSlash",
    description:
      "Run the PixelSlash review app yourself: in Docker, on your own Cloudflare account or on your own box.",
  },
  {
    to: "/security",
    label: "Security",
    title: "Security · PixelSlash",
    description:
      "How to report a security problem in PixelSlash, and which parts of the project the policy covers.",
  },
] as const;

export type SitePath = (typeof PAGES)[number]["to"];
