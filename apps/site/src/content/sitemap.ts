import { DOC_PAGES } from "./docs-map.ts";
import { PAGES } from "./pages.ts";
import { SITE_URL } from "./seo.ts";

/** Every page of the site, as its canonical URL. */
export function sitemapXml(): string {
  const paths = [...PAGES.map((page) => page.to), ...DOC_PAGES.map((page) => `/docs/${page.slug}`)];
  const urls = paths.map((path) => `  <url><loc>${SITE_URL}${path}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
