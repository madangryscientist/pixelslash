/**
 * The dogfood capture's setup (dogfood-orgs.config.ts): sign in through the GitHub stand-in, then
 * seed the fixed rows. Seeding comes after the sign-in because the seed's memberships point at the
 * user the first sign-in creates. The session stays in the capture's memory; nothing is saved.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { CaptureSetup } from "@pixelslash/engine";
import { PERSIST, STUB, WEB } from "./dogfood-orgs.config";
import { seedSql } from "./dogfood-seed";

async function waitFor(url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`the GitHub stand-in did not come up at ${url}`);
}

const setup: CaptureSetup = async ({ page }) => {
  await waitFor(`${STUB}/health`);
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.waitForURL(/\/orgs/);

  const seed = join(WEB, PERSIST, "tmp", "seed.sql");
  await Bun.write(seed, seedSql());
  execFileSync(
    "bunx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--env",
      "e2e",
      "--persist-to",
      PERSIST,
      "--file",
      seed,
    ],
    {
      cwd: WEB,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, TMPDIR: join(WEB, PERSIST, "tmp") },
    },
  );
};

export default setup;
