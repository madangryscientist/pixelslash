import { expect, type Locator, type Page } from "@playwright/test";

/** The layer's box once it has stopped moving: the same on two reads a frame apart. */
async function settledBox(page: Page, layer: Locator) {
  await layer.scrollIntoViewIfNeeded();
  let last = "";
  let settled = { x: 0, y: 0, width: 0, height: 0 };
  await expect
    .poll(async () => {
      const box = await layer.boundingBox();
      if (!box || box.width === 0 || box.height === 0) return false;
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      const now = JSON.stringify(box);
      const same = now === last;
      last = now;
      settled = box;
      return same;
    })
    .toBe(true);
  return settled;
}

/**
 * Drag over a draw layer from (`fromX`, `fromY`) to (`toX`, `toY`), each a fraction of the layer.
 * It waits for the layer to be attached and its box to hold still first, so the drag does not land
 * on a layout that is still moving.
 */
export async function dragOver(
  page: Page,
  layer: Locator,
  [fromX, fromY]: readonly [number, number],
  [toX, toY]: readonly [number, number],
) {
  const box = await settledBox(page, layer);
  const at = (fx: number, fy: number) => [box.x + fx * box.width, box.y + fy * box.height] as const;
  await page.mouse.move(...at(fromX, fromY));
  await page.mouse.down();
  await page.mouse.move(...at(toX, toY), { steps: 4 });
  await page.mouse.up();
}
