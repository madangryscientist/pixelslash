/**
 * The held-out corpus (ob 1488): the same categories as cases.ts, rendered from three pages the
 * main corpus never sees (bench/fixtures-holdout/). Tuning work must not look at these cases; it
 * looks at the numbers, side by side with the main corpus, to find out whether a change helped
 * beyond the pages it was tuned on.
 *
 * Every page gets the same recipe, filled in with its own selectors and fragments, so the two
 * corpora measure the same things on different pages and the cases are easy to compare.
 */
import {
  caretBar,
  HINT_FULL,
  HINT_LCD,
  HINT_NONE,
  NO_SUBPIXEL,
  noise,
  real,
  same,
  seek,
  setSvg,
  setText,
  type CaseDef,
  type Variant,
} from "./case-kit.ts";

type Recipe = { head: Variant; box: string[] };

type PageSpec = {
  page: string;
  /** Selectors moved by a fraction of a pixel: a container, and a block inside it. */
  shift: { container: string; part: string };
  caret: { selector: string; x: number };
  /** An element that gets a box-shadow, and where an emoji line is added. */
  shadow: string;
  emojiHost: string;
  /** The real changes, one recipe each. */
  padding: Recipe;
  gap: Recipe;
  cardFade: Recipe;
  buttonSubtle: Recipe;
  buttonClear: Recipe;
  word: Recipe;
  number: Recipe;
  missingIcon: Recipe;
  missingRow: Recipe;
  iconSwap: Recipe;
  stack: Recipe;
  border: Recipe;
  step: Recipe;
  glyph: Recipe;
  /** Real: the page grows; only the pages with room to grow carry one. */
  grow?: string;
  /** Pages where the first and second hinting pair differ, so three pages cover the three pairs. */
  hinting: [Variant, Variant];
};

const CROSS = `<circle cx="8" cy="8" r="7" fill="#dc2626"/><path d="M5 5l6 6M11 5l-6 6" stroke="#fff" stroke-width="1.8" fill="none"/>`;

const recipe = (css: string, box: string[]): Recipe => ({ head: { css }, box });
const recipeJs = (js: string, box: string[]): Recipe => ({ head: { js }, box });

const emojiLine = (host: string) =>
  `document.querySelector(${JSON.stringify(host)}).insertAdjacentHTML("beforeend", '<p id="emoji" style="margin:14px 0 0;font-size:18px">🎉 Shipped ✅ 🚀 Nice work 👍</p>');`;
const grow = (host: string, margin: number) =>
  `document.querySelector(${JSON.stringify(host)}).insertAdjacentHTML("beforeend", '<p id="extra" style="margin-top:${margin}px">Need help? Contact support and we will reply within a day.</p>');`;

function forPage(p: PageSpec): CaseDef[] {
  const n = (kind: string) => `${kind}-${p.page}`;
  const cases: CaseDef[] = [
    // noise: font hinting, glyph positioning
    noise("hinting", n("hinting"), p.page, ...p.hinting),
    noise("text-rendering", n("subpixel-glyphs"), p.page, {}, { args: NO_SUBPIXEL }),
    // noise: sub-pixel layout shift
    noise(
      "subpixel-shift",
      n("shift-container"),
      p.page,
      {},
      { css: `${p.shift.container}{transform:translate(.3px,.2px)}` },
    ),
    noise(
      "subpixel-shift",
      n("shift-part"),
      p.page,
      {},
      { css: `${p.shift.part}{position:relative;left:.4px}` },
    ),
    // noise: caret, animation frame, dither, compression
    noise("caret", n("caret"), p.page, {}, { css: caretBar(p.caret.selector, p.caret.x) }),
    noise("animation", n("animation-frame"), p.page, { js: seek(150) }, { js: seek(500) }),
    noise("dither", n("dither"), p.page, {}, { dither: { seed: 7, amp: 1, density: 0.2 } }),
    noise("compression", n("jpeg80"), p.page, {}, { jpeg: 80 }),
    noise("compression", n("webp85"), p.page, {}, { webp: 85 }),
    // noise: gradient banding, shadow blur, colour-font glyphs
    noise(
      "banding",
      n("banding"),
      p.page,
      { css: "body{background:linear-gradient(180deg,#f7f7f8,#dadade)}" },
      { css: "body{background:linear-gradient(180deg,#f7f7f8 .5%,#dadade 100.5%)}" },
    ),
    noise(
      "shadow",
      n("shadow-blur"),
      p.page,
      { css: `${p.shadow}{box-shadow:0 2px 8px rgba(0,0,0,.14)}` },
      { css: `${p.shadow}{box-shadow:0 2px 9.5px rgba(0,0,0,.14)}` },
    ),
    noise(
      "emoji",
      n("emoji-subpixel"),
      p.page,
      { js: emojiLine(p.emojiHost) },
      { js: emojiLine(p.emojiHost), css: "#emoji{transform:translateX(.35px)}" },
    ),

    // real changes
    real("spacing", n("spacing-padding-1px"), p.page, p.padding.head, p.padding.box),
    real("spacing", n("spacing-gap-1px"), p.page, p.gap.head, p.gap.box),
    real("colour", n("colour-card-fade"), p.page, p.cardFade.head, p.cardFade.box),
    real("colour", n("colour-button-subtle"), p.page, p.buttonSubtle.head, p.buttonSubtle.box),
    real("colour", n("colour-button-clear"), p.page, p.buttonClear.head, p.buttonClear.box),
    real("text", n("text-word"), p.page, p.word.head, p.word.box),
    real("text", n("text-number"), p.page, p.number.head, p.number.box),
    real("missing", n("missing-icon"), p.page, p.missingIcon.head, p.missingIcon.box),
    real("missing", n("missing-row-reflow"), p.page, p.missingRow.head, p.missingRow.box),
    real("icon", n("icon-swap"), p.page, p.iconSwap.head, p.iconSwap.box),
    real("reflow", n("reflow-stack"), p.page, p.stack.head, p.stack.box),
    real("border", n("border-1px"), p.page, p.border.head, p.border.box),
    real("colour-1step", n("colour-1step"), p.page, p.step.head, p.step.box),
    real("glyph", n("glyph"), p.page, p.glyph.head, p.glyph.box),
  ];
  if (p.grow)
    cases.push(
      real("size", n("size-append"), p.page, { js: p.grow }, ["#extra"], { fullPage: true }),
    );
  return cases;
}

const SETTINGS: PageSpec = {
  page: "settings",
  shift: { container: "main", part: "#card-notify" },
  caret: { selector: "#name", x: 100 },
  shadow: ".card",
  emojiHost: "main",
  hinting: [HINT_NONE, HINT_FULL],
  padding: recipe("#save{padding-left:17px}", ["#save", "#sync"]),
  gap: recipe("#toggles{gap:11px}", ["#card-notify", ".actions"]),
  cardFade: recipe("#card-profile{background:#f3f4f8}", ["#card-profile"]),
  buttonSubtle: recipe("#save{background:#554cea}", ["#save"]),
  buttonClear: recipe("#save{background:#dc2626}", ["#save"]),
  word: recipeJs(
    setText("#intro", "Choose how your name and role appear to everyone in the workspace."),
    ["text:#intro"],
  ),
  number: recipeJs(setText("#seat-count", "15"), ["text:#seat-count"]),
  missingIcon: recipe("#icon-at{visibility:hidden}", ["#icon-at"]),
  missingRow: recipe("#toggles #t2{display:none}", ["#card-notify", ".actions"]),
  iconSwap: recipeJs(setSvg("#icon-clock", CROSS), ["#icon-clock"]),
  stack: recipe("#fields{flex-direction:column}", ["#card-profile", "#card-notify", ".actions"]),
  border: recipe("#name{border-width:2px}", ["#name"]),
  step: recipe("#save{background:#5046e5}", ["#save"]),
  glyph: recipeJs(setText("#t2 > span:first-of-type", "Mentions and replias"), [
    "text:#t2 > span:first-of-type",
  ]),
  grow: grow("main", 90),
};

const PRICING: PageSpec = {
  page: "pricing",
  shift: { container: "main", part: "#plans" },
  caret: { selector: "#email", x: 130 },
  shadow: "#hero",
  emojiHost: "#hero",
  hinting: [HINT_NONE, HINT_LCD],
  padding: recipe("#subscribe{padding-left:17px}", ["#news"]),
  gap: recipe(".plan ul{gap:7px}", ["#plans"]),
  cardFade: recipe("#plan-free{background:#faf5ec}", ["#plan-free"]),
  buttonSubtle: recipe("#cta-pro{background:#ee5a12}", ["#cta-pro"]),
  buttonClear: recipe("#cta-pro{background:#0f766e}", ["#cta-pro"]),
  word: recipeJs(
    setText(
      "#lede",
      "Start free, upgrade when your team grows. No hidden fees, cancel whenever you like.",
    ),
    ["text:#lede"],
  ),
  number: recipeJs(`document.querySelector("#price-pro").firstChild.textContent = "$39";`, [
    "#price-pro",
  ]),
  missingIcon: recipe("#tick-1{visibility:hidden}", ["#tick-1"]),
  missingRow: recipe("#plan-team{display:none}", ["#plans"]),
  iconSwap: recipeJs(setSvg("#tick-1", CROSS), ["#tick-1"]),
  stack: recipe("#plans{flex-direction:column}", ["#plans", "#news"]),
  border: recipe("#plan-free{border-width:2px}", ["#plans"]),
  step: recipe("#cta-pro{background:#eb580c}", ["#cta-pro"]),
  glyph: recipeJs(setText("#ribbon", "Populer"), ["#ribbon"]),
  grow: grow("main", 200),
};

const INBOX: PageSpec = {
  page: "inbox",
  shift: { container: "main", part: "#mails" },
  caret: { selector: "#search", x: 70 },
  shadow: "#mails",
  emojiHost: "main",
  hinting: [HINT_FULL, HINT_LCD],
  padding: recipe("#compose{padding-left:15px}", ["#bar"]),
  gap: recipe("#mails li{gap:11px}", ["#mails"]),
  cardFade: recipe("#mails{background:#f8f9fb}", ["#mails"]),
  buttonSubtle: recipe("#compose{background:#1070d0}", ["#compose"]),
  buttonClear: recipe("#compose{background:#dc2626}", ["#compose"]),
  word: recipeJs(setText("#m3 .subject", "Re: roadmap review, updated notes attached"), [
    "text:#m3 .subject",
  ]),
  number: recipeJs(setText("#range-count", "1–6"), ["text:#range-count"]),
  missingIcon: recipe("#icon-m2{visibility:hidden}", ["#icon-m2"]),
  missingRow: recipe("#mails #m3{display:none}", ["#mails", "#foot"]),
  iconSwap: recipeJs(setSvg("#icon-m4", CROSS), ["#icon-m4"]),
  stack: recipe("#bar{flex-direction:column;align-items:stretch}", ["#bar", "#mails", "#foot"]),
  border: recipe("#search{border-width:2px}", ["#search"]),
  step: recipe("#compose{background:#0b6bcc}", ["#compose"]),
  glyph: recipeJs(setText("#m4 .from", "Design tean"), ["text:#m4 .from"]),
  grow: grow("main", 120),
};

export const HOLDOUT_CASES: CaseDef[] = [
  same("identical-settings", "settings"),
  same("identical-pricing", "pricing"),
  same("identical-inbox", "inbox"),
  same("identical-settings-hinting-none", "settings", { base: HINT_NONE, head: HINT_NONE }),
  ...forPage(SETTINGS),
  ...forPage(PRICING),
  ...forPage(INBOX),
];
