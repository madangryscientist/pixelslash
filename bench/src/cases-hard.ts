/**
 * The harder half of the main corpus (ob 1488): more lossy encodings, gradient banding, shadows
 * and colour-font glyphs that are noise, and the finest real changes. Same pages as cases.ts.
 */
import { NO_SUBPIXEL, noise, real, setText, type CaseDef } from "./case-kit.ts";

const EMOJI_LINE = `document.querySelector("main").insertAdjacentHTML("beforeend", '<p id="emoji" style="margin:16px 0 0;font-size:18px">🎉 Deploy shipped ✅ 🚀 Nice work 👍</p>');`;

export const HARD_CASES: CaseDef[] = [
  // noise: lossy compression at more qualities, JPEG and WebP (ob 1488)
  noise("compression", "jpeg70-form", "form", {}, { jpeg: 70 }),
  noise("compression", "jpeg50-article", "article", {}, { jpeg: 50 }),
  noise("compression", "webp90-dashboard", "dashboard", {}, { webp: 90 }),
  noise("compression", "webp75-form", "form", {}, { webp: 75 }),
  // noise: gradient banding. The same smooth gradient with its band edges a pixel apart.
  noise(
    "banding",
    "banding-stops-dashboard",
    "dashboard",
    { css: "body{background:linear-gradient(180deg,#f4f4f5,#d9d9de)}" },
    { css: "body{background:linear-gradient(180deg,#f4f4f5 .5%,#d9d9de 100.5%)}" },
  ),
  noise(
    "banding",
    "banding-interpolation-article",
    "article",
    { css: "body{background:linear-gradient(90deg,#fff,#e4e4e7)}" },
    { css: "body{background:linear-gradient(in oklab 90deg,#fff,#e4e4e7)}" },
  ),
  // noise: a box-shadow drawn a little differently (Skia quantises blur, so a step is 8px to 9.5px)
  noise(
    "shadow",
    "shadow-blur-dashboard",
    "dashboard",
    { css: ".stat{box-shadow:0 2px 8px rgba(0,0,0,.12)}" },
    { css: ".stat{box-shadow:0 2px 9.5px rgba(0,0,0,.12)}" },
  ),
  noise(
    "shadow",
    "shadow-offset-form",
    "form",
    { css: "form{box-shadow:0 4px 12px rgba(0,0,0,.1)}" },
    { css: "form{box-shadow:0 4.3px 12px rgba(0,0,0,.1)}" },
  ),
  // noise: colour-font (emoji) glyphs placed on a different sub-pixel
  noise(
    "emoji",
    "emoji-subpixel-dashboard",
    "dashboard",
    { js: EMOJI_LINE },
    { js: EMOJI_LINE, css: "#emoji{transform:translateX(.35px)}" },
  ),
  noise(
    "emoji",
    "emoji-glyph-positioning-form",
    "form",
    { js: EMOJI_LINE },
    { js: EMOJI_LINE, args: NO_SUBPIXEL },
  ),

  // real: the finest changes: one pixel of border, one step of one colour channel, one glyph
  real("border", "border-1px-stat", "dashboard", { css: "#stat-users{border-width:2px}" }, [
    ".stats",
    "#activity",
    ".actions",
  ]),
  real("border", "border-1px-select", "form", { css: "select{border-width:2px}" }, ["select"]),
  real(
    "colour-1step",
    "colour-1step-button",
    "dashboard",
    { css: "#primary{background:#2563ec}" },
    ["#primary"],
  ),
  real("colour-1step", "colour-1step-submit", "form", { css: "#submit{background:#19181b}" }, [
    "#submit",
  ]),
  real(
    "glyph",
    "glyph-row-label",
    "dashboard",
    { js: setText("#row-1 > span:first-of-type", "Deploy finished for wed") },
    ["text:#row-1 > span:first-of-type"],
  ),
  real(
    "glyph",
    "glyph-meta-digit",
    "article",
    { js: setText("#meta", "Posted 12 March · 5 min read") },
    ["text:#meta"],
  ),
];
