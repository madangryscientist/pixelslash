import { expect, test } from "@playwright/test";
import { createOrg } from "./orgs-page";

test("mint an org token in the org settings, see it is live, revoke it", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs/);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();

  const orgId = await createOrg(page, "Monorepo Co");

  await page.getByRole("link", { name: /^Tokens/ }).click();
  await expect(page).toHaveURL(/tab=tokens/);
  await expect(page.getByTestId("no-org-tokens")).toBeVisible();
  await expect(page.getByRole("button", { name: "Issue org token" })).toBeDisabled();

  await page.getByLabel("Org token name, e.g. monorepo CI").fill("monorepo CI");
  await page.getByRole("button", { name: "Issue org token" }).click();
  const token = (await page.getByTestId("issued-org-token").textContent()) ?? "";
  expect(token).toMatch(/^psorg_/);
  const row = page.getByTestId("org-token-row").filter({ hasText: "monorepo CI" });
  await expect(row).toContainText(token.slice(0, 8));
  await expect(row).toContainText("active");

  // The shown token is live: it is its org.
  const auth = { authorization: `Bearer ${token}` };
  const me = await request.get("/api/v1/me", { headers: auth });
  expect(await me.json()).toMatchObject({ kind: "org-ci", orgId });

  // Shown once: after a reload only the prefix is left.
  await page.reload();
  await expect(page.getByTestId("issued-org-token")).toHaveCount(0);
  await expect(page.getByText(token)).toHaveCount(0);
  await expect(row).toContainText(token.slice(0, 8));

  await expect(page.locator("[data-hydrated=true]")).toHaveCount(1);
  await row.getByRole("button", { name: "Revoke monorepo CI" }).click();
  await expect(row).toContainText("revoked");
  await expect(row.getByRole("button", { name: "Revoke monorepo CI" })).toHaveCount(0);
  expect((await request.get("/api/v1/me", { headers: auth })).status()).toBe(401);
});
