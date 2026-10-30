/**
 * Lossy encodings for the corpus (ob 1477, ob 1488): the shot is encoded with a lossy codec and
 * decoded again, and what the decoder produced is the PNG that goes in the corpus.
 */
import type { Browser, Page } from "playwright";

export type Size = { width: number; height: number };
type Shot = { quality: number; fullPage: boolean; viewport: Size };

type Img = { naturalWidth: number; naturalHeight: number; decode(): Promise<void> };
declare const document: {
  fonts: { ready: Promise<unknown> };
  getElementById(id: string): Img;
  createElement(tag: "canvas"): {
    width: number;
    height: number;
    getContext(kind: "2d"): { drawImage(img: Img, x: number, y: number): void };
    toDataURL(type: string, quality: number): string;
  };
};

export async function roundTripJpeg(browser: Browser, page: Page, jpeg: Shot) {
  const bytes = await page.screenshot({
    type: "jpeg",
    quality: jpeg.quality,
    fullPage: jpeg.fullPage,
  });
  const helper = await browser.newPage({ viewport: jpeg.viewport });
  try {
    await helper.setContent(
      `<body style="margin:0"><img id="i" src="data:image/jpeg;base64,${bytes.toString("base64")}"></body>`,
    );
    await helper.waitForFunction(() => document.fonts.ready);
    await helper.waitForTimeout(100);
    return await helper.screenshot({ type: "png", fullPage: true });
  } finally {
    await helper.close();
  }
}

/** Chromium screenshots to JPEG but not WebP; a canvas encodes WebP, and an <img> decodes it again. */
export async function roundTripWebp(browser: Browser, page: Page, webp: Shot) {
  const png = await page.screenshot({ type: "png", fullPage: webp.fullPage });
  const helper = await browser.newPage({ viewport: webp.viewport });
  try {
    await helper.setContent(
      `<body style="margin:0"><img id="src" src="data:image/png;base64,${png.toString("base64")}"></body>`,
    );
    const url = await helper.evaluate(async (quality) => {
      const img = document.getElementById("src");
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      return canvas.toDataURL("image/webp", quality / 100);
    }, webp.quality);
    await helper.setContent(`<body style="margin:0"><img id="out" src="${url}"></body>`);
    await helper.evaluate(async () => {
      await document.getElementById("out").decode();
    });
    return await helper.screenshot({ type: "png", fullPage: true });
  } finally {
    await helper.close();
  }
}
