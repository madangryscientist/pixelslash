import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type Setup, cleanup, current, deploy, pack, releaseNames, setup } from "./update-harness";

// update.sh refuses to deploy under a live build (PS-228).
afterEach(cleanup);

const MIN = 60_000;
// A release already serving, so there is a D1 to ask; the next deploy is the one under test.
function serving() {
  const s = setup();
  expect(deploy(s, pack("aaaaaaa")).status).toBe(0);
  return s;
}
const nothingChanged = (s: Setup) => {
  expect(current(s)).toBe(join(s.releases, "aaaaaaa"));
  expect(releaseNames(s)).toEqual(["aaaaaaa"]);
};

describe("a build in flight (PS-228)", () => {
  test("a build processing now blocks the deploy, and nothing changes", () => {
    const s = serving();
    s.build("b-live", "processing", 2 * MIN);

    const { status, stderr, commands } = deploy(s, pack("bbbbbbb"));

    expect(status).toBe(1);
    expect(stderr).toContain("refusing to deploy: a build is processing");
    expect(stderr).toContain("b-live");
    expect(stderr).toContain("PIXELSLASH_DEPLOY_FORCE=1");
    nothingChanged(s);
    expect(commands.filter((line) => !line.includes("d1 execute"))).toEqual([]);
  });

  test("PIXELSLASH_DEPLOY_FORCE=1 deploys anyway", () => {
    const s = serving();
    s.build("b-live", "processing", 2 * MIN);

    const { status, commands } = deploy(s, pack("bbbbbbb"), { PIXELSLASH_DEPLOY_FORCE: "1" });

    expect(status).toBe(0);
    expect(current(s)).toBe(join(s.releases, "bbbbbbb"));
    expect(commands.some((line) => line.includes("d1 execute"))).toBe(false);
  });

  test("an old stuck processing build does not block", () => {
    const s = serving();
    s.build("7a698500", "processing", 3 * 60 * MIN);
    s.build("b-done", "changes", 1 * MIN);
    s.build("b-new", "uploading", 1 * MIN);

    expect(deploy(s, pack("bbbbbbb")).status).toBe(0);
    expect(current(s)).toBe(join(s.releases, "bbbbbbb"));
  });

  test("a D1 that cannot be asked blocks too, and FORCE gets past it", () => {
    const s = serving();
    // Only the question fails; the migrations and the install still work.
    writeFileSync(
      join(s.stubs, "bunx"),
      "#!/usr/bin/env bash\n" +
        '[[ " $* " != *" d1 execute "* ]] || { echo "no such table: builds" >&2; exit 1; }\n',
    );

    const blocked = deploy(s, pack("bbbbbbb"));
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("could not ask the D1 whether a build is in flight");
    nothingChanged(s);

    expect(deploy(s, pack("bbbbbbb"), { PIXELSLASH_DEPLOY_FORCE: "1" }).status).toBe(0);
  });

  test("the first release, with nothing serving, has no D1 to ask and goes ahead", () => {
    const s = setup();
    s.build("b-live", "processing", MIN);
    const { status, commands } = deploy(s, pack("aaaaaaa"));
    expect(status).toBe(0);
    expect(commands.some((line) => line.includes("d1 execute"))).toBe(false);
  });
});
