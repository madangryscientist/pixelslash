import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { DOC_PAGES, neighbours } from "../src/content/docs-map.ts";
import { PAGES } from "../src/content/pages.ts";

/*
 * Every page, on a desktop and a phone: the nav and the footer are there, every internal link and
 * anchor lands on something, nothing links to the hosted app while it is closed, and nothing scrolls sideways. That the docs and compare pages agree with their source
 * files is checked in the unit tests (src/content/docs.test.tsx, matrix.test.tsx).
 */

const CLOSED = ["app.pixelslash.dev"];

async function hrefs(page: Page): Promise<string[]> {
  return page
    .locator("a[href]")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
}

async function idsOn(page: Page, path: string): Promise<Set<string>> {
  const html = await (await page.request.get(path)).text();
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ""));
}

const DOC_PATHS = DOC_PAGES.map((item) => `/docs/${item.slug}`);

/** The nav, footer, links, anchors and width checks every page of the site passes. */
async function checkPage(
  page: Page,
  to: string,
  info: { project: { name: string } },
): Promise<void> {
  {
    const response = await page.goto(to);
    expect(response?.status()).toBe(200);

    const nav = page.getByTestId("site-nav");
    for (const item of PAGES)
      await expect(nav.getByRole("link", { name: item.label, exact: true })).toHaveCount(1);

    const footer = page.getByTestId("footer");
    await expect(footer.getByTestId("trademark")).toContainText("PixelSlash is a name of");
    await expect(footer.getByRole("link", { name: "hello@hack-cove.com" })).toHaveAttribute(
      "href",
      "mailto:hello@hack-cove.com",
    );
    await expect(footer.getByTestId("source-status")).toHaveText("GitHub");
    await expect(footer.getByTestId("source-status")).toHaveAttribute(
      "href",
      "https://github.com/madangryscientist/pixelslash",
    );

    const known = new Set<string>([...PAGES.map((item) => item.to), ...DOC_PATHS]);
    for (const href of await hrefs(page)) {
      expect(
        CLOSED.some((closed) => href.includes(closed)),
        `${href} leads somewhere closed`,
      ).toBe(false);
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [path = "", anchor] = href.split("#");
      const target = path === "" ? to : path;
      expect(known.has(target), `${href} is not a page of the site`).toBe(true);
      if (anchor)
        expect((await idsOn(page, target)).has(anchor), `${href}: no #${anchor} on ${target}`).toBe(
          true,
        );
    }

    const width = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(width, "the page scrolls sideways").toBe(0);

    const dir = process.env["SITE_SHOTS_DIR"];
    if (dir) {
      const name = to === "/" ? "home" : to.slice(1).replaceAll("/", "-");
      // Still, and with every scroll reveal shown: a full-page shot does not scroll the page.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.screenshot({
        path: join(dir, `${name}-${info.project.name}.png`),
        fullPage: true,
      });
    }
  }
}

for (const { to, label } of PAGES) {
  test(`${label} (${to}): nav, footer, links`, async ({ page }, info) => {
    await checkPage(page, to, info);
  });
}

test("/docs is the index: a card per group, every page linked, the rail marks All docs", async ({
  page,
}, info) => {
  await checkPage(page, "/docs", info);
  const index = page.getByTestId("docs-index");
  for (const item of DOC_PAGES)
    await expect(index.locator(`a[href="/docs/${item.slug}"]`)).toHaveCount(1);
  await expect(page.getByTestId("docs-nav").locator('a[href="/docs"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
});

for (const doc of DOC_PAGES) {
  test(`/docs/${doc.slug}: group nav, on this page, previous and next`, async ({ page }, info) => {
    await checkPage(page, `/docs/${doc.slug}`, info);
    const nav = page.getByTestId("docs-nav");
    for (const other of DOC_PAGES)
      await expect(nav.locator(`a[href="/docs/${other.slug}"]`)).toHaveCount(1);
    await expect(nav.locator(`a[href="/docs/${doc.slug}"]`)).toHaveAttribute(
      "aria-current",
      "page",
    );

    const { prev, next } = neighbours(doc.slug);
    if (prev)
      await expect(page.getByTestId("docs-prev").locator("a")).toHaveAttribute(
        "href",
        `/docs/${prev.slug}`,
      );
    if (next)
      await expect(page.getByTestId("docs-next").locator("a")).toHaveAttribute(
        "href",
        `/docs/${next.slug}`,
      );

    // The rail is the desktop view; a phone gets the fold above the page.
    const contents = info.project.name.includes("mobile")
      ? page.locator("details", { hasText: "On this page" })
      : page.getByTestId("docs-contents");
    if ((await contents.count()) > 0) await expect(contents.first()).toBeVisible();
  });
}

test("an old /docs#anchor lands on the page that holds it, scrolled to the heading", async ({
  page,
}) => {
  await page.goto("/docs#uploading-to-a-server");
  await page.waitForURL("**/docs/upload#uploading-to-a-server");
  await expect(page.locator("#uploading-to-a-server")).toBeInViewport();
});

test("an unknown docs page is a 404", async ({ page }) => {
  const response = await page.goto("/docs/no-such-page");
  expect(response?.status()).toBe(404);
});

/*
 * The type face (PS-307): every page renders in the Inter this site serves, light and dark. The face
 * is requested from the site's own origin and loads; nothing is requested from another origin. The
 * browser's own report of the font it drew with (CDP getPlatformFontsForNode) is the proof, not the
 * computed font-family, which names a stack and says nothing about what was used.
 */
for (const scheme of ["light", "dark"] as const) {
  for (const to of [...PAGES.map((item) => item.to), ...DOC_PATHS]) {
    test(`${to}: served Inter in ${scheme}, from this origin`, async ({ page, baseURL }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const origin = new URL(baseURL ?? "").origin;
      const foreign: string[] = [];
      const fonts: { url: string; ok: boolean }[] = [];
      page.on("response", (response) => {
        const url = response.url();
        if (/\.woff2?(\?|$)/.test(url)) fonts.push({ url, ok: response.ok() });
      });
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== origin) foreign.push(request.url());
      });

      await page.goto(to, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);

      expect(foreign, "a request left the site's own origin").toEqual([]);
      expect(fonts.map((font) => new URL(font.url).pathname)).toEqual([
        "/fonts/inter-latin-wght-normal.woff2",
      ]);
      expect(fonts.every((font) => font.ok)).toBe(true);
      await expect(page.locator("html")).toHaveClass(
        scheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      );

      const loaded = await page.evaluate(() =>
        [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family),
      );
      expect(loaded.map((family) => family.replaceAll('"', ""))).toContain("Inter");

      // What the browser drew with: Inter, the served file, for the page's heading and its body.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      // The first heading and the first body text (paragraph, list item or cell) with text of its own that
      // is on screen: a phone hides some copy.
      await page.evaluate(() => {
        const probes = { heading: "h1, h1 > span", body: "p, li, td, dd" };
        for (const [name, selector] of Object.entries(probes)) {
          const shown = [...document.querySelectorAll(selector)].find((element) => {
            const box = element.getBoundingClientRect();
            const ownText = [...element.childNodes].some(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            );
            // checkVisibility is false inside a closed <details>: it has boxes but paints nothing.
            return element.checkVisibility() && box.width > 1 && box.height > 1 && ownText;
          });
          shown?.setAttribute("data-font-probe", name);
        }
      });
      for (const tag of ["heading", "body"]) {
        const { nodeId } = await cdp.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: `[data-font-probe="${tag}"]`,
        });
        expect(nodeId, `no visible ${tag} on ${to}`).not.toBe(0);
        const { fonts: used } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        expect(used.length, `${tag} drew no text`).toBeGreaterThan(0);
        // Some of it in Inter: a glyph outside the served Latin subset (an arrow) may use another.
        const inter = used.filter((font) => font.familyName === "Inter" && font.isCustomFont);
        expect(inter.length, `${tag} on ${to} was not drawn with the served Inter`).toBeGreaterThan(
          0,
        );
      }
    });
  }
}

/*
 * One scheme scope on <html>, and a logo that holds on it (PS-308). Light pages take Latte through the
 * `latte` class, dark pages Mocha through `dark`; exactly one is ever set, and it is set before first
 * paint (the inline script runs in <head>, so what is read here is what the first frame had). The
 * wordmark's fills come from that scope, not from values in the site, so what is asserted is what the
 * browser drew: the two schemes give different fills, and each reads against the page's own ground
 * (WCAG contrast of at least 3, the bar for graphics).
 */
const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const channel = (value: number) => {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};
const luminance = (value: string) => {
  const [r = 0, g = 0, b = 0] = rgb(value);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: string, b: string) => {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

for (const scheme of ["light", "dark"] as const) {
  test(`the ${scheme} scope is set alone and the wordmark reads on it`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/pricing", { waitUntil: "networkidle" });

    const html = page.locator("html");
    await expect(html).toHaveClass(scheme === "dark" ? /\bdark\b/ : /\blatte\b/);
    await expect(html).not.toHaveClass(scheme === "dark" ? /\blatte\b/ : /\bdark\b/);

    const fills = async () => ({
      letters: await page
        .getByTestId("wordmark-letters")
        .first()
        .evaluate((el) => getComputedStyle(el).fill),
      slash: await page
        .getByTestId("wordmark-slash")
        .first()
        .evaluate((el) => getComputedStyle(el).fill),
    });
    // The first opaque background behind the wordmark: the header paints one, the body may not.
    const ground = await page
      .getByTestId("wordmark-letters")
      .first()
      .evaluate((el) => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          const colour = getComputedStyle(node).backgroundColor;
          if (!/rgba\(.*,\s*0\)$|transparent/.test(colour)) return colour;
        }
        return "rgb(255, 255, 255)";
      });
    const seen = await fills();
    expect(
      contrast(seen.letters, ground),
      `letters ${seen.letters} on ${ground}`,
    ).toBeGreaterThanOrEqual(3);
    expect(contrast(seen.slash, ground), `slash ${seen.slash} on ${ground}`).toBeGreaterThanOrEqual(
      3,
    );

    // The same two marks drawn in the other scheme are not the same colours.
    await page.emulateMedia({ colorScheme: scheme === "dark" ? "light" : "dark" });
    await page.reload({ waitUntil: "networkidle" });
    expect(await fills()).not.toEqual(seen);
  });
}

/*
 * The sticky header stays on top (PS-306):a card's links are lifted above the card's own overlay, and
 * once scrolled they must still sit under the header. What is asserted is what is painted: the header's
 * band is shot as it is, then again with every link in the page body hidden; the two must match, so no
 * link has drawn a pixel over the header. The page is walked down in steps, so a link crosses the band.
 */
for (const scheme of ["light", "dark"] as const) {
  test(`/docs scrolled: no link paints over the header in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto("/docs", { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);

    const clip = await page.locator("header").first().boundingBox();
    if (!clip) throw new Error("the header has no box");
    const reach = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );

    let crossings = 0;
    for (let y = 0; y <= reach; y += 40) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      // Only the cards' links are lifted, so only they have to cross the band for the check to bite.
      crossings += await page.evaluate(() => {
        const bottom = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
        return [...document.querySelectorAll('[data-testid="docs-index"] a')].filter((link) => {
          const box = link.getBoundingClientRect();
          return box.top < bottom && box.bottom > 0;
        }).length;
      });
      const drawn = await page.screenshot({ clip });
      const hide = await page.addStyleTag({ content: "main a { visibility: hidden !important; }" });
      const bare = await page.screenshot({ clip });
      await hide.evaluate((node) => node instanceof Element && node.remove());
      expect(drawn.equals(bare), `a link painted over the header at scroll ${y}`).toBe(true);
    }
    expect(crossings, "no card link ever passed under the header").toBeGreaterThan(0);
  });
}
