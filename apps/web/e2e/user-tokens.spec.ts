import { expect, test } from "@playwright/test";

test("issue a personal token in settings, see it once, use it, revoke it", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);

  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
  await expect(page.getByTestId("no-tokens")).toBeVisible();
  await expect(page.getByRole("button", { name: "Issue token" })).toBeDisabled();

  await page.getByLabel("Token name, e.g. laptop").fill("laptop");
  await page.getByLabel("Expires").selectOption("30");
  await page.getByRole("button", { name: "Issue token" }).click();
  const token = (await page.getByTestId("issued-token").textContent()) ?? "";
  expect(token).toMatch(/^psu_/);
  const row = page.getByRole("row", { name: /laptop/ });
  await expect(row).toContainText(token.slice(0, 8));
  await expect(row).toContainText("active");
  await expect(row).toContainText("never");

  // The API knows who it is.
  const auth = { authorization: `Bearer ${token}` };
  const me = await request.get("/api/v1/me", { headers: auth });
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ kind: "user", user: { login: expect.any(String) } });

  // Shown once: after a reload only the prefix is left.
  await page.reload();
  await expect(page.getByTestId("issued-token")).toHaveCount(0);
  await expect(page.getByText(token)).toHaveCount(0);
  await expect(row).toContainText(token.slice(0, 8));

  await expect(page.locator("[data-hydrated=true]")).toHaveCount(1);
  await row.getByRole("button", { name: "Revoke laptop" }).click();
  await expect(row).toContainText("revoked");
  await expect(row.getByRole("button", { name: "Revoke laptop" })).toHaveCount(0);
  expect((await request.get("/api/v1/me", { headers: auth })).status()).toBe(401);
});
