/**
 * The corpus, as data (ob 1477). Each case renders one fixture page twice, `base` and `head`, and
 * is labelled by what a reviewer should conclude: `identical`, `noise` (a change nobody would want
 * flagged) or `real` (a change somebody should see, with the elements it touches in `box`).
 */
export type Dither = { seed: number; amp: number; density: number };

export type Variant = {
  /** Render this file (path from the repo root) instead of the case's fixture page. */
  source?: string;
  /** Extra CSS injected after load. */
  css?: string;
  /** A JS expression-statement run in the page after load, before the shot. */
  js?: string;
  /** Extra Chromium flags; a different flag set means a different browser launch. */
  args?: string[];
  /** A fontconfig file from fixtures/fontconfig/ (hinting and anti-aliasing), by name without `.conf`. */
  fontconfig?: string;
  /** Post-process the PNG: seeded +-amp noise on `density` of the pixels (GPU rasterisation drift). */
  dither?: Dither;
  /** Round-trip the shot through JPEG at this quality (lossy compression artefacts). */
  jpeg?: number;
};

export type Label = "identical" | "noise" | "real";

export type CaseDef = {
  name: string;
  label: Label;
  /** Category inside the label, for the per-category table. */
  kind: string;
  page: "dashboard" | "form" | "article" | "pages";
  fullPage?: boolean;
  base: Variant;
  head: Variant;
  /**
   * Real cases: selectors whose rects (in either render) make the ground-truth box. A `text:`
   * prefix takes the rect of the text itself, not of the (often full-width) element holding it.
   */
  box?: string[];
};

const same = (name: string, page: CaseDef["page"], extra: Partial<CaseDef> = {}): CaseDef => ({
  name,
  label: "identical",
  kind: "identical",
  page,
  base: {},
  head: {},
  ...extra,
});

const noise = (
  kind: string,
  name: string,
  page: CaseDef["page"],
  ...pair: [base: Variant, head: Variant]
): CaseDef => ({ name: `noise-${name}`, label: "noise", kind, page, base: pair[0], head: pair[1] });

const real = (
  kind: string,
  name: string,
  page: CaseDef["page"],
  ...spec: [head: Variant, box: string[], extra?: Partial<CaseDef>]
): CaseDef => ({
  name: `real-${name}`,
  label: "real",
  kind,
  page,
  base: {},
  head: spec[0],
  box: spec[1],
  ...spec[2],
});

const HINT_NONE: Variant = { fontconfig: "hint-none" };
const HINT_FULL: Variant = { fontconfig: "hint-full" };
const HINT_LCD: Variant = { fontconfig: "hint-slight-lcd" };
const NO_SUBPIXEL = ["--disable-font-subpixel-positioning"];

const ICON_CROSS = `<circle cx="8" cy="8" r="7" fill="#dc2626"/><path d="M5 5l6 6M11 5l-6 6" stroke="#fff" stroke-width="1.8" fill="none"/>`;
const LOGO_PLUS = `<rect width="24" height="24" rx="6" fill="#2563eb"/><path d="M12 6v12M6 12h12" stroke="#fff" stroke-width="2.5" fill="none"/>`;
const ICON_I = `<circle cx="8" cy="8" r="7" fill="#2563eb"/><path d="M8 7v5M8 4v1" stroke="#fff" stroke-width="1.8" fill="none"/>`;

const PULSE = "@keyframes pulse{50%{opacity:.55}}#badge{animation:pulse 2s infinite}";
const SHIMMER =
  "@keyframes sh{to{background-position:100% 0}}#hero{background-size:200% 100%;animation:sh 3s linear infinite}";
const seek = (ms: number) =>
  `document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${ms}; });`;
const caretBar = (sel: string, x: number) =>
  `${sel}{background:linear-gradient(#18181b,#18181b) no-repeat ${x}px center / 1px 16px,#fff}`;
const setText = (sel: string, text: string) =>
  `document.querySelector(${JSON.stringify(sel)}).textContent = ${JSON.stringify(text)};`;
const setSvg = (sel: string, inner: string) =>
  `document.querySelector(${JSON.stringify(sel)}).innerHTML = ${JSON.stringify(inner)};`;

export const CASES: CaseDef[] = [
  // identical: the same page rendered twice
  same("identical-dashboard", "dashboard"),
  same("identical-form", "form"),
  same("identical-article", "article"),
  same("identical-dashboard-fullpage", "dashboard", { fullPage: true }),
  same("identical-form-hinting-none", "form", { base: HINT_NONE, head: HINT_NONE }),

  // noise: font hinting and sub-pixel (LCD) anti-aliasing, set through fontconfig
  noise("hinting", "hinting-none-vs-full-dashboard", "dashboard", HINT_NONE, HINT_FULL),
  noise("hinting", "hinting-none-vs-lcd-form", "form", HINT_NONE, HINT_LCD),
  noise("hinting", "hinting-full-vs-lcd-article", "article", HINT_FULL, HINT_LCD),
  // noise: glyph positioning and text rendering mode
  noise("text-rendering", "subpixel-glyphs-article", "article", {}, { args: NO_SUBPIXEL }),
  noise("text-rendering", "subpixel-glyphs-dashboard", "dashboard", {}, { args: NO_SUBPIXEL }),
  noise(
    "text-rendering",
    "geometric-precision-article",
    "article",
    { css: "body{text-rendering:optimizeSpeed}" },
    { css: "body{text-rendering:geometricPrecision}" },
  ),
  // noise: sub-pixel layout shift
  noise(
    "subpixel-shift",
    "shift-dashboard-main",
    "dashboard",
    {},
    { css: "main{transform:translate(.3px,.2px)}" },
  ),
  noise(
    "subpixel-shift",
    "shift-form-main",
    "form",
    {},
    { css: "main{transform:translate(.5px,0)}" },
  ),
  noise(
    "subpixel-shift",
    "shift-article-main",
    "article",
    {},
    { css: "main{transform:translateX(.25px)}" },
  ),
  noise(
    "subpixel-shift",
    "shift-dashboard-stats",
    "dashboard",
    {},
    { css: ".stats{position:relative;left:.4px}" },
  ),
  // noise: text caret. Headless Chromium does not paint the real one, so it is a 1px bar where it would be.
  noise("caret", "caret-email", "form", {}, { css: caretBar("#email", 120) }),
  noise("caret", "caret-first-name", "form", {}, { css: caretBar("#first", 37) }),
  // noise: animation frame (every animation seeked to a different time and held there)
  noise("animation", "spinner-frame", "dashboard", { js: seek(100) }, { js: seek(400) }),
  noise(
    "animation",
    "badge-pulse-frame",
    "form",
    { css: PULSE, js: seek(200) },
    { css: PULSE, js: seek(600) },
  ),
  noise(
    "animation",
    "hero-shimmer-frame",
    "article",
    { css: SHIMMER, js: seek(500) },
    { css: SHIMMER, js: seek(700) },
  ),
  // noise: colour-channel drift on a minority of pixels (GPU rasterisation, gradient dithering)
  noise(
    "dither",
    "dither-dashboard-1",
    "dashboard",
    {},
    { dither: { seed: 1, amp: 1, density: 1 } },
  ),
  noise(
    "dither",
    "dither-article-2",
    "article",
    {},
    { dither: { seed: 2, amp: 2, density: 0.05 } },
  ),
  noise("dither", "dither-form-1", "form", {}, { dither: { seed: 3, amp: 1, density: 0.3 } }),
  // noise: lossy compression
  noise("compression", "jpeg95-dashboard", "dashboard", {}, { jpeg: 95 }),
  noise("compression", "jpeg85-article", "article", {}, { jpeg: 85 }),

  // real: 1px spacing
  real(
    "spacing",
    "spacing-button-padding-1px",
    "dashboard",
    { css: "#primary{padding-left:17px}" },
    ["#primary", "#spinner"],
  ),
  real("spacing", "spacing-list-gap-1px", "dashboard", { css: "#activity ul{gap:9px}" }, [
    "#activity",
    ".actions",
  ]),
  real("spacing", "spacing-paragraph-margin-1px", "article", { css: "p{margin-bottom:13px}" }, [
    "text:#p1",
    "text:#quote",
    "text:#p2",
    "text:#list li",
    "text:#p3",
  ]),
  real("spacing", "spacing-form-gap-1px", "form", { css: "form{gap:13px}" }, ["form"]),
  // real: colour shift
  real("colour", "colour-card-fade", "dashboard", { css: ".stat{background:#f4f4f5}" }, [".stat"]),
  real("colour", "colour-button-subtle", "dashboard", { css: "#primary{background:#2a69ee}" }, [
    "#primary",
  ]),
  real("colour", "colour-button-clear", "dashboard", { css: "#primary{background:#dc2626}" }, [
    "#primary",
  ]),
  real("colour", "colour-body-text-subtle", "article", { css: "body{color:#3f3f46}" }, [
    "text:#p1",
    "text:#p2",
    "text:#p3",
    "text:#list li",
  ]),
  real(
    "colour",
    "colour-banner-hue",
    "dashboard",
    { css: "#banner{background:linear-gradient(90deg,#2563eb,#db2777)}" },
    ["#banner"],
  ),
  real("colour", "colour-badge", "form", { css: "#badge{background:#fef9c3;color:#854d0e}" }, [
    "#badge",
  ]),
  real("colour", "colour-input-border", "form", { css: "input[type=text]{border-color:#2563eb}" }, [
    "input[type=text]",
  ]),
  // real: the card of fixtures/pages going from white to the page grey was the first thing Argos missed (docs/research/argos-local.md)
  {
    name: "real-fixture-pages-card-to-yellow",
    label: "real",
    kind: "colour",
    page: "pages",
    base: { source: "fixtures/pages/live.html" },
    head: { source: "fixtures/pages/local.html" },
    box: [".card"],
  },
  // real: text change
  real(
    "text",
    "text-word",
    "article",
    {
      js: setText(
        "#p3",
        "None of this is hard, but it has to be done every time, by default, or the noise comes back.",
      ),
    },
    ["text:#p3"],
  ),
  real("text", "text-number", "dashboard", { js: setText("#stat-users .value", "1,205") }, [
    "text:#stat-users .value",
  ]),
  real("text", "text-button-longer", "form", { js: setText("#submit", "Create your account") }, [
    "#submit",
  ]),
  real("text", "text-weight", "article", { css: "#title{font-weight:400}" }, ["text:#title"]),
  real(
    "text",
    "text-lede",
    "form",
    { js: `document.querySelector(".lede").firstChild.textContent = "Takes about two minutes. ";` },
    ["text:.lede"],
  ),
  // real: missing element
  real("missing", "missing-icon", "dashboard", { css: "#icon-2{visibility:hidden}" }, ["#icon-2"]),
  real("missing", "missing-button", "dashboard", { css: "#primary{visibility:hidden}" }, [
    "#primary",
  ]),
  real("missing", "missing-row-reflow", "dashboard", { css: "#activity #row-2{display:none}" }, [
    "#activity",
    ".actions",
  ]),
  real("missing", "missing-avatar", "dashboard", { css: "#avatar{visibility:hidden}" }, [
    "#avatar",
  ]),
  real("missing", "missing-hero", "article", { css: "#hero{visibility:hidden}" }, ["#hero"]),
  // real: icon swap
  real("icon", "icon-check-to-cross", "dashboard", { js: setSvg("#icon-1", ICON_CROSS) }, [
    "#icon-1",
  ]),
  real("icon", "icon-logo-plus", "dashboard", { js: setSvg("#logo", LOGO_PLUS) }, ["#logo"]),
  real("icon", "icon-info-glyph", "dashboard", { js: setSvg("#icon-2", ICON_I) }, ["#icon-2"]),
  // real: layout reflow
  real("reflow", "reflow-stats-column", "dashboard", { css: ".stats{flex-direction:column}" }, [
    ".stats",
    "#activity",
    ".actions",
  ]),
  real("reflow", "reflow-form-row-stack", "form", { css: ".row{flex-direction:column}" }, ["form"]),
  real("reflow", "reflow-nav-right", "dashboard", { css: "nav{justify-content:flex-end}" }, [
    "nav",
  ]),
  real("reflow", "reflow-article-narrower", "article", { css: "main{max-width:460px}" }, ["main"]),
  // real: the page grows. PixelSlash diffs only the overlap (invariant 1); Argos pads and counts the rest.
  real(
    "size",
    "size-append-section",
    "dashboard",
    {
      js: `document.querySelector("main").insertAdjacentHTML("beforeend", '<section id="extra" class="stat" style="margin-top:60px;height:90px">Appended section</section>');`,
    },
    ["#extra"],
    { fullPage: true },
  ),
  real(
    "size",
    "size-append-paragraph",
    "form",
    {
      js: `document.querySelector("main").insertAdjacentHTML("beforeend", '<p id="extra" style="margin-top:40px">Need help? Contact support and we will reply within a day.</p>');`,
    },
    ["#extra"],
    { fullPage: true },
  ),
];
