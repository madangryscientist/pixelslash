import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { BuildTimings as CliTimings } from "#/db/diff-json";
import { createOrg, createProject } from "#/db/orgs";
import { builds } from "#/db/schema";
import { testDb } from "#/db/test-db";
import { signInGithubUser } from "#/db/users";
import { RERUN_NOTE } from "#/lib/timings";
import { byTestId } from "#/test/by-test-id";
import { BuildTimings } from "./build-timings";

/**
 * The build page's "This run" card as the page draws it: a row per stored server step, the CLI's
 * steps and its note, the speed profile of a current CLI, and no profile for an older one. The
 * words come from `lib/run-card` and `lib/timings`, tested on their own; this proves the card
 * puts them on the page under the test ids the page is read by.
 */

const CLI: CliTimings = { totalMs: 900, captureMs: 400, shots: [] };

const SETTLE = { fontsMs: 120, imagesMs: 340, networkIdleMs: 5500, framesMs: 40 };

/** What a current CLI sends: the capture's wall and workers, its parts, the requests' spread and the host. */
const PROFILE: CliTimings = {
  totalMs: 21_000,
  browserLaunchMs: 400,
  captureWallMs: 4_200,
  workers: { capture: 4, upload: 4 },
  host: { cores: 16, loadStart: 3.2, loadEnd: 4.1 },
  captureMs: 10_000,
  navigateMs: 1_000,
  settleMs: 7_000,
  screenshotMs: 1_200,
  setupMs: 500,
  storyMs: 600,
  measureMs: 300,
  settle: SETTLE,
  upload: {
    totalMs: 9_000,
    batches: [
      { step: "upload", count: 120, ms: 20_000, p50Ms: 180, p90Ms: 420, maxMs: 900, wallMs: 3_200 },
      {
        step: "finalize",
        count: 1,
        ms: 9_500,
        p50Ms: 9_500,
        p90Ms: 9_500,
        maxMs: 9_500,
        wallMs: 9_500,
      },
    ],
  },
  shots: [{ name: "hero", captureMs: 10_000, navigateMs: 1_000, settleMs: 7_000, settle: SETTLE }],
};

/** A real build row, as `buildView` selects it, with these columns set. */
async function build(over: Partial<typeof builds.$inferInsert>) {
  const db = testDb();
  const user = await signInGithubUser(db, {
    githubId: 1,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const org = await createOrg(db, user.id, "Acme");
  const project = await createProject(db, user.id, org.id, "web");
  const values = {
    id: crypto.randomUUID(),
    projectId: project.id,
    commitSha: "a".repeat(40),
    branch: "work",
    status: "changes",
    ...over,
  } satisfies typeof builds.$inferInsert;
  await db.insert(builds).values(values);
  const [row] = await db.select().from(builds);
  if (!row) throw new Error("no build row");
  return row;
}

const render = (row: Awaited<ReturnType<typeof build>>) =>
  renderToStaticMarkup(
    <BuildTimings build={{ ...row }} shots={[]} defaultBranch="main" recaptures={null} />,
  );

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

describe("a diffed build's timings card", () => {
  const ran = {
    queueMs: 1_200,
    diffMs: 3_400,
    processingStartedAt: at(0),
    finishedAt: at(3_500),
    timings: CLI,
  };

  test("states the server's before-diff and diff steps, and a total that says it starts at the diff", async () => {
    const html = render(await build(ran));
    expect(byTestId(html, "timing-server-diff")).toMatch(/diff\s+3\.4/);
    expect(byTestId(html, "timing-server-queue")).toContain("before diff");
    expect(byTestId(html, "timing-server-total")).toContain("total from diff start");
  });

  test("a first run has no re-run note, and a project with no model has no explanation or summary step", async () => {
    const html = render(await build(ran));
    expect(html).not.toContain('data-testid="timings-server-note"');
    expect(html).not.toContain('data-testid="timing-server-explain"');
    expect(html).not.toContain('data-testid="timing-server-summary"');
  });

  test("a build that took a second run says its numbers are the latest run's", async () => {
    const html = render(await build({ ...ran, rerun: true }));
    expect(byTestId(html, "timings-server-note")).toBe(RERUN_NOTE);
  });

  test("the CLI's total is shown with the note that it is the wall clock", async () => {
    const html = render(await build(ran));
    expect(byTestId(html, "timing-cli-total")).toContain("900");
    expect(byTestId(html, "timings-cli-note")).toContain("wall-clock");
  });
});

describe("a build from a current CLI", () => {
  test("shows the capture wall, its parts' shares, each request kind's spread and the host, each under its test id", async () => {
    const html = render(await build({ timings: PROFILE }));
    expect(byTestId(html, "profile-capture-wall-text")).toMatch(
      /^4\.2.s against 10.s of worker time, on 4 workers$/,
    );
    const parts = byTestId(html, "profile-capture-parts-text");
    expect(parts).toContain("settle 70% (");
    expect(parts).toContain("network idle 55%");
    expect(byTestId(html, "profile-requests-upload-text")).toMatch(
      /p50 180.ms, p90 420.ms, max 900.ms/,
    );
    expect(byTestId(html, "profile-requests-finalize-text")).toContain("p90");
    expect(byTestId(html, "profile-host-text")).toBe(
      "16 cores, load 3.2 at the start and 4.1 at the end",
    );
  });

  test("an older CLI's build shows its steps and no profile row", async () => {
    const html = render(await build({ timings: CLI }));
    expect(byTestId(html, "timing-cli-capture")).toContain("400");
    expect(html).not.toContain('data-testid="profile-');
  });
});
