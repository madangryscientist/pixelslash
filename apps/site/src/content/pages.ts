/** Every page of the site, in nav order. The build prerenders each one; the nav and the smoke test read the same list. */
export const PAGES = [
  { to: "/", label: "Home" },
  { to: "/how-it-works", label: "How it works" },
  { to: "/docs", label: "Docs" },
  { to: "/self-host", label: "Self-host" },
  { to: "/compare", label: "Compare" },
  { to: "/pricing", label: "Pricing" },
  { to: "/security", label: "Security" },
] as const;
