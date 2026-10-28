import { expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";

/**
 * The side panel's disclosures and the slider (PS-265): Branch is drawn at Main's scale, the divider follows a drag on the image,
 * and its handle is a keyboard slider.
 */

test("Details and Tools start shut; the slider draws both shots at one scale, drags on the image and takes the keyboard", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Slider Co", "slider");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();

  // The side panel leads with the summary; Details and Tools start collapsed and open with a click.
  await expect(page.getByTestId("sizes")).toBeHidden();
  for (const name of ["Details", "Tools"]) {
    const toggle = page.getByRole("button", { name, exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
  await expect(page.getByTestId("sizes")).toBeVisible();
  await expect(page.getByTestId("rerun-shot")).toBeVisible();

  await page.getByRole("radio", { name: "Slider" }).click();

  const range = page.getByLabel("Compare position");
  const handle = page.getByRole("slider", { name: "Divider" });
  await expect(range).toHaveValue("50");
  await expect(handle).toHaveAttribute("aria-valuenow", "50");

  // At 50 the branch layer is as wide as the main one, not half of it.
  const [main, branch] = await Promise.all([
    page.getByTestId("slider-main").boundingBox(),
    page.getByTestId("slider-branch").boundingBox(),
  ]);
  if (!main || !branch) throw new Error("no layer");
  expect(branch.width).toBeCloseTo(main.width, 0);
  expect(main.width).toBeGreaterThan(0);

  // A drag on the image moves the divider to the pointer.
  const frame = await page.getByTestId("slider-frame").boundingBox();
  if (!frame) throw new Error("no frame");
  const y = frame.y + frame.height / 2;
  await page.mouse.move(frame.x + frame.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.8, y, { steps: 5 });
  await page.mouse.up();
  const dragged = Number(await handle.getAttribute("aria-valuenow"));
  expect(dragged).toBeGreaterThan(70);
  await expect(range).toHaveValue(String(dragged));

  // The handle is in the tab order after the toolbar (a few stops on from the range), and the
  // arrows move it.
  await range.focus();
  for (let stops = 0; stops < 10; stops++) {
    await page.keyboard.press("Tab");
    if (await handle.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(handle).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", String(dragged - 1));
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "0");
  await expect(range).toHaveValue("0");
});
