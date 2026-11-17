/**
 * Shoots the site's `report.png` (`apps/site/scripts/site-images.ts`): the e2e servers and sign-in of
 * `playwright.config.ts`, running only `e2e/site-report.shoot.ts`. The `.shoot.ts` name keeps the shoot
 * out of the e2e run, whose specs are `*.spec.ts`.
 */
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const [setup, chromium] = base.projects ?? [];

export default defineConfig({
  ...base,
  projects: [
    { ...setup },
    { ...chromium, name: "site-report", testMatch: /site-report\.shoot\.ts/ },
  ],
});
