/**
 * Every page of the site, in nav order. The build prerenders each one; the nav, the head of each
 * page, the sitemap and the smoke test read the same list.
 */
export const PAGES = [
  {
    to: "/",
    label: "Home",
    title: "PixelSlash: visual review for the web",
    description:
      "PixelSlash diffs two versions of a page and shows what changed. Open source, MIT, self-hostable.",
  },
  {
    to: "/how-it-works",
    label: "How it works",
    title: "How it works · PixelSlash",
    description:
      "One PixelSlash run, step by step: capture Main and Branch, diff the pixels perceptually, and read the report it writes.",
  },
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
    to: "/compare",
    label: "Compare",
    title: "How we compare · PixelSlash",
    description:
      "PixelSlash against five other visual testing tools, capability by capability, with the rows where it is behind left in.",
  },
  {
    to: "/pricing",
    label: "Pricing",
    title: "Pricing · PixelSlash",
    description:
      "PixelSlash is free and you can run all of it yourself. There is no paid plan to buy; the whole product is in the open-source repository.",
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
