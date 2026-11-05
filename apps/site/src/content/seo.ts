import { PAGES, type SitePath } from "./pages.ts";

export const SITE_URL = "https://pixelslash.dev";
const SOCIAL_CARD = { path: "/social-card.png", width: 1200, height: 630 } as const;
const SOCIAL_CARD_ALT = "PixelSlash: see what your change did to the page.";

type Head = {
  meta: Array<Record<string, string>>;
  links: Array<{ rel: string; href: string }>;
};

/** What a page says about itself to a search engine and to a link preview. */
export function headFor(path: string, title: string, description: string): Head {
  const url = `${SITE_URL}${path}`;
  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "PixelSlash" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { property: "og:image", content: `${SITE_URL}${SOCIAL_CARD.path}` },
      { property: "og:image:width", content: String(SOCIAL_CARD.width) },
      { property: "og:image:height", content: String(SOCIAL_CARD.height) },
      { property: "og:image:alt", content: SOCIAL_CARD_ALT },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}

/** The head of a page in `PAGES`. */
export function pageHead(path: SitePath): Head {
  const page = PAGES.find((item) => item.to === path);
  if (page === undefined) throw new Error(`no page ${path}`);
  return headFor(path, page.title, page.description);
}
