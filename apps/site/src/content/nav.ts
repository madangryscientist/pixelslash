import { MOVED } from "./moved.ts";
import { PAGES } from "./pages.ts";

/** One link of the site nav: a page here (`local`), or a marketing page on slashslash.build. */
export type NavItem = { label: string; href: string; local: boolean };

/** The site nav in its order: the moved marketing pages link to slashslash.build, the rest are here. */
export const NAV: readonly NavItem[] = [
  MOVED[0],
  MOVED[1],
  PAGES[0],
  PAGES[1],
  MOVED[2],
  MOVED[3],
  PAGES[2],
].map((item) =>
  "from" in item
    ? { label: item.label, href: item.target, local: false }
    : { label: item.label, href: item.to, local: true },
);
