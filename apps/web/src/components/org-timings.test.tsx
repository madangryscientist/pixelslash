import { describe, expect, test } from "vitest";
import { createOrg, createProject } from "#/db/orgs";
import { builds } from "#/db/schema";
import { testDb } from "#/db/test-db";
import { orgTimings } from "#/db/timings-stats";
import { signInGithubUser } from "#/db/users";
import { renderRouted, textOf } from "#/test/render-routed";
import { TimingsPanel } from "./org-timings";

/**
 * The org's Timings tab, from the builds in the database to the page: a project row with its build
 * count and the median and slowest of a step, what Total covers, and a sentence, not a row of
 * dashes, for a project with no finished build. The statistics are `orgTimings`' own tests.
 */

const now = new Date("2026-10-24T12:00:00Z");

async function setup() {
  const db = testDb();
  const ada = await signInGithubUser(db, {
    githubId: 1,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const org = await createOrg(db, ada.id, "Timings Co");
  const project = await createProject(db, ada.id, org.id, "timed");
  return { db, ada, org, project };
}

const rowOf = (html: string) => /<tr[^>]*data-testid="timings-row"[\s\S]*?<\/tr>/.exec(html)?.[0];

describe("the Timings tab", () => {
  test("a project with finished builds shows its build count and a median over the slowest, marked max", async () => {
    const { db, ada, org, project } = await setup();
    for (const [i, diffMs] of [900, 1_400].entries()) {
      const end = new Date(now.getTime() - 1_000 * (i + 1));
      await db.insert(builds).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        commitSha: "a".repeat(40),
        branch: "main",
        status: "passed",
        diffMs,
        processingStartedAt: new Date(end.getTime() - diffMs),
        finishedAt: end,
      });
    }
    const html = await renderRouted(
      <TimingsPanel projects={await orgTimings(db, ada.id, org.id, now)} />,
    );
    const row = rowOf(html);
    const text = textOf(row ?? "");
    expect(text).toMatch(/^timed 2 /);
    expect(text).toContain("900 ms / 1.4 s max");
    expect(/data-testid="timings-diff-tail"[^>]*>([^<]*)</.exec(row ?? "")?.[1]).toBe("max");
    // Every build ran the step, so no count sits beside the figures; no build summarised, so n/a.
    expect(row).not.toContain("timings-total-count");
    expect(/data-testid="timings-summary"[^>]*>([^<]*)</.exec(row ?? "")?.[1]).toBe("n/a");
  });

  test("the tab says what Total covers and what it leaves out", async () => {
    const { db, ada, org } = await setup();
    const html = await renderRouted(
      <TimingsPanel projects={await orgTimings(db, ada.id, org.id, now)} />,
    );
    expect(html).toContain('aria-label="Timings"');
    expect(textOf(html)).toContain("Total runs from the diff starting");
  });

  test("with no finished build it says so in a sentence and draws no project row", async () => {
    const { db, ada, org } = await setup();
    const html = await renderRouted(
      <TimingsPanel projects={await orgTimings(db, ada.id, org.id, now)} />,
    );
    expect(/data-testid="timings-empty"[^>]*>([\s\S]*?)<\/li>/.exec(html)?.[1]).toContain(
      "No finished builds in the last 30 days",
    );
    expect(html).not.toContain('data-testid="timings-row"');
  });
});
