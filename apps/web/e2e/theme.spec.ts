import { expect, test } from "@playwright/test";

test.describe("a visitor who follows the system and has chosen nothing", () => {
  test.use({ colorScheme: "dark" });

  test("reaches dark with no cookie", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await page.context().cookies()).toEqual([]);
  });
});

test.describe("a light system", () => {
  test.use({ colorScheme: "light" });

  test("starts light, and an explicit choice survives a reload with the class server-rendered", async ({
    page,
  }) => {
    await page.goto("/");
    const toggle = page.getByTestId("theme-toggle");
    await expect(toggle).toBeEnabled();
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await toggle.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    // The label names the theme it switches to, so it flips with the page.
    await expect(toggle).toHaveAccessibleName("Switch to light theme");

    // No flash: the document the server sends already carries the class, before any script runs.
    const html = await (await page.request.get("/")).text();
    expect(html).toMatch(/<html[^>]*class="(?:[^"]* )?dark[ "]/);

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(toggle).toHaveAccessibleName("Switch to light theme");

    await toggle.click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    const light = await (await page.request.get("/")).text();
    expect(light).not.toMatch(/<html[^>]*class="(?:[^"]* )?dark[ "]/);
  });
});

test("an explicit light choice beats a dark system", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto("/");
  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await context.close();
});
