import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Browser } from "@playwright/test";
import { SERVER } from "./ports";

const WEB = fileURLToPath(new URL("..", import.meta.url));

/** One statement against the running e2e D1, as the wrangler CLI does. */
function sql(command: string) {
  return spawnSync(
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
      ".wrangler/e2e",
      "--command",
      command,
    ],
    { cwd: WEB, encoding: "utf8" },
  );
}

/**
 * A rival member: a real user in another org, with a session inserted straight into D1. `id` keeps
 * one spec's rival apart from another's in the same database; returns the session token.
 */
export async function rivalSession(
  id = "rival",
  githubId = 9999,
  org = "Rival Co",
): Promise<string> {
  const token = `pss_e2e_${id}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const user = sql(
    `INSERT INTO users (id, github_id, login) VALUES ('${id}-user', ${githubId}, '${id}')`,
  );
  const made = sql(`INSERT INTO orgs (id, name) VALUES ('${id}-org', '${org}')`);
  const member = sql(`INSERT INTO members (org_id, user_id) VALUES ('${id}-org', '${id}-user')`);
  const session = sql(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ('${hash}', '${id}-user', ${Date.now() + 3_600_000})`,
  );
  for (const result of [user, made, member, session]) {
    if (result.status !== 0) throw new Error(`seeding the rival failed: ${result.stderr}`);
  }
  return token;
}

/** A browser context signed in as the rival. */
export async function rivalContext(browser: Browser, token: string) {
  const context = await browser.newContext();
  await context.addCookies([{ name: "ps_session", value: token, url: SERVER }]);
  return context;
}
