import { expect, test } from "@playwright/test";

test("throwaway failure that proves CI keeps the trace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "this heading does not exist" })).toBeVisible({
    timeout: 2000,
  });
});
