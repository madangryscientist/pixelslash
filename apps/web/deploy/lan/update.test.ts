import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

// update.sh, the CT-side half of a LAN deploy, run against temp directories. The root-only pieces
// are stubbed: `runuser` runs its command as this user; `systemctl`, `journalctl`, `bun` and `bunx`
// only log. `wait_for_port` is replaced after the script is sourced: :3000 never opens while
// `current` is a release holding a BROKEN file, which stands in for a serve.ts that exits.
const SCRIPT = fileURLToPath(new URL("./update.sh", import.meta.url));
const LAN = fileURLToPath(new URL(".", import.meta.url));
const UNITS = ["pixelslash-stub.service", "pixelslash-diff.service", "pixelslash-web.service"];

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function setup() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "update-sh-")));
  const home = join(root, "home");
  const legacyWeb = join(home, "pixelslash/apps/web");
  const stubs = join(root, "stubs");
  const unitDir = join(root, "units");
  const log = join(root, "commands.log");

  // The checkout the CT served from before PS-225: its state and its secrets.
  mkdirSync(join(legacyWeb, ".wrangler/state/v3"), { recursive: true });
  writeFileSync(join(legacyWeb, ".wrangler/state/v3/builds"), "42 builds\n");
  writeFileSync(join(legacyWeb, ".dev.vars.e2e"), "IMAGE_SIGNING_SECRET=ct-secret\n");
  mkdirSync(unitDir);

  mkdirSync(stubs);
  const stub = (name: string, body: string) => {
    writeFileSync(join(stubs, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(stubs, name), 0o755);
  };
  stub("runuser", 'while [[ $1 != -- ]]; do shift; done\nshift\nexec "$@"');
  for (const name of ["systemctl", "journalctl", "bun", "bunx"])
    stub(name, `echo "${name} $* @ $PWD" >>"$STUB_LOG"`);

  return { home, legacyWeb, stubs, unitDir, log, releases: join(home, "releases") };
}

type Setup = ReturnType<typeof setup>;

// A release tarball as release.sh packs it, cut down to what update.sh touches.
function pack(sha: string, { broken = false, sentryDsn = "" } = {}) {
  const dir = join(root, "pack", sha);
  mkdirSync(join(dir, "apps/web/deploy/lan"), { recursive: true });
  for (const unit of [...UNITS, "pixelslash-opencode.service"])
    copyFileSync(join(LAN, unit), join(dir, "apps/web/deploy/lan", unit));
  mkdirSync(join(dir, "apps/web/dist/server"), { recursive: true });
  writeFileSync(join(dir, "apps/web/dist/server/index.js"), `// ${sha}\n`);
  if (broken) writeFileSync(join(dir, "apps/web/BROKEN"), "");
  // What release.sh adds when PIXELSLASH_SENTRY_DSN is set.
  if (sentryDsn) writeFileSync(join(dir, ".sentry-dsn"), `${sentryDsn}\n`, { mode: 0o600 });
  const tarball = join(root, `pixelslash-${sha}.tar.gz`);
  const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, "."]);
  expect(tar.status).toBe(0);
  return tarball;
}

function deploy(s: Setup, tarball: string) {
  writeFileSync(s.log, "");
  const harness = [
    'source "$1"',
    "wait_for_port() { [[ $1 != 3000 || ! -e $CURRENT/apps/web/BROKEN ]]; }",
    'main "$2"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", harness, "_", SCRIPT, tarball], {
    env: {
      ...process.env,
      PIXELSLASH_HOME: s.home,
      PIXELSLASH_APP_PATH: `${s.stubs}:/usr/bin:/bin`,
      PIXELSLASH_UNIT_DIR: s.unitDir,
      PIXELSLASH_HELPER_SWITCH: join(root, "no-helper-switch"),
      PIXELSLASH_D1_RETRY_SLEEP: "0",
      STUB_LOG: s.log,
      PATH: `${s.stubs}:${process.env["PATH"]}`,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stderr: result.stderr,
    commands: readFileSync(s.log, "utf8").split("\n").filter(Boolean),
  };
}

const varsOf = (rel: string) => readFileSync(join(rel, "apps/web/dist/server/.dev.vars"), "utf8");
const current = (s: Setup) => readlinkSync(join(s.releases, "current"));
const releaseNames = (s: Setup) =>
  readdirSync(s.releases)
    .filter((name) => name !== "current")
    .toSorted();

describe("update.sh", () => {
  test("installs a release beside the old checkout and switches to it", () => {
    const s = setup();
    const { status, stderr, commands } = deploy(s, pack("aaaaaaa"));
    const rel = join(s.releases, "aaaaaaa");

    expect({ status, stderr }).toEqual({ status: 0, stderr: expect.any(String) });
    expect(current(s)).toBe(rel);
    // The state is the old checkout's, linked, and the CT's secrets are copied in, private.
    expect(readlinkSync(join(rel, "apps/web/.wrangler/state"))).toBe(
      join(s.legacyWeb, ".wrangler/state"),
    );
    expect(readFileSync(join(rel, "apps/web/.wrangler/state/v3/builds"), "utf8")).toBe(
      "42 builds\n",
    );
    expect(readFileSync(join(rel, "apps/web/dist/server/.dev.vars"), "utf8")).toContain(
      "ct-secret",
    );
    expect(statSync(join(rel, "apps/web/dist/server/.dev.vars")).mode & 0o777).toBe(0o600);
    expect(readdirSync(s.unitDir).toSorted()).toEqual([...UNITS].toSorted());

    // Install and migrate in the new release, then the sidecar, then the server. Nothing builds.
    const at = (prefix: string) => commands.findIndex((line) => line.startsWith(prefix));
    expect(commands).toContain(`bun install --frozen-lockfile --production @ ${rel}`);
    expect(commands).toContain(
      `bunx wrangler d1 migrations apply DB --local --env e2e @ ${rel}/apps/web`,
    );
    expect(at("bunx wrangler d1 migrations")).toBeLessThan(at("systemctl restart pixelslash-diff"));
    expect(at("systemctl restart pixelslash-diff")).toBeLessThan(
      at("systemctl restart pixelslash-stub pixelslash-web"),
    );
    expect(commands.filter((line) => /build/.test(line))).toEqual([]);
  });

  test("a release that does not come up goes back to the previous one", () => {
    const s = setup();
    expect(deploy(s, pack("aaaaaaa")).status).toBe(0);

    const { status, stderr, commands } = deploy(s, pack("bbbbbbb", { broken: true }));

    expect(status).toBe(1);
    expect(stderr).toContain("going back to aaaaaaa");
    expect(current(s)).toBe(join(s.releases, "aaaaaaa"));
    expect(releaseNames(s)).toEqual(["aaaaaaa"]);
    const restarts = commands.filter((line) => line.startsWith("systemctl restart"));
    expect(restarts.at(-1)).toMatch(
      /^systemctl restart pixelslash-diff pixelslash-stub pixelslash-web/,
    );
    // The state is not touched by a rollback.
    expect(readFileSync(join(s.legacyWeb, ".wrangler/state/v3/builds"), "utf8")).toBe(
      "42 builds\n",
    );
  });

  test("keeps the last three releases", () => {
    const s = setup();
    for (const sha of ["aaaaaaa", "bbbbbbb", "ccccccc", "ddddddd", "eeeeeee"])
      expect(deploy(s, pack(sha)).status).toBe(0);

    expect(releaseNames(s)).toEqual(["ccccccc", "ddddddd", "eeeeeee"]);
    expect(current(s)).toBe(join(s.releases, "eeeeeee"));
    expect(existsSync(join(s.legacyWeb, ".wrangler/state/v3/builds"))).toBe(true);

    // Going back to a kept release points `current` at it again and copies the secrets in again;
    // it is not unpacked again.
    writeFileSync(join(s.legacyWeb, ".dev.vars.e2e"), "IMAGE_SIGNING_SECRET=rotated\n");
    const back = deploy(s, pack("ddddddd"));
    expect(back.status).toBe(0);
    expect(current(s)).toBe(join(s.releases, "ddddddd"));
    expect(back.commands.some((line) => line.startsWith("bun install"))).toBe(false);
    expect(readFileSync(join(s.releases, "ddddddd/apps/web/dist/server/.dev.vars"), "utf8")).toBe(
      "IMAGE_SIGNING_SECRET=rotated\n",
    );

    // A kept release that fails to go back to is kept: this deploy did not unpack it.
    writeFileSync(join(s.stubs, "bunx"), "#!/usr/bin/env bash\nexit 1\n");
    expect(deploy(s, pack("ccccccc")).status).toBe(1);
    expect(current(s)).toBe(join(s.releases, "ddddddd"));
    expect(releaseNames(s)).toEqual(["ccccccc", "ddddddd", "eeeeeee"]);
  });

  test("a D1 locked by an upload is tried again", () => {
    const s = setup();
    // wrangler fails on the lock twice, then migrates.
    writeFileSync(
      join(s.stubs, "bunx"),
      [
        "#!/usr/bin/env bash",
        'echo "bunx $* @ $PWD" >>"$STUB_LOG"',
        'n=$(grep -c "^bunx" "$STUB_LOG")',
        '((n > 2)) || { echo "database is locked: SQLITE_BUSY"; exit 1; }',
      ].join("\n"),
    );

    const { status, commands } = deploy(s, pack("aaaaaaa"));

    expect(status).toBe(0);
    expect(current(s)).toBe(join(s.releases, "aaaaaaa"));
    expect(commands.filter((line) => line.startsWith("bunx wrangler d1 migrations"))).toHaveLength(
      3,
    );
  });

  test("the wait for a port ends when its unit has exited", () => {
    const s = setup();
    // systemctl reports the unit waiting to be restarted; nothing listens on port 1.
    writeFileSync(join(s.stubs, "systemctl"), "#!/usr/bin/env bash\necho auto-restart\n");
    const started = Date.now();
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" && wait_for_port 1 60 pixelslash-web', "_", SCRIPT],
      { env: { ...process.env, PATH: `${s.stubs}:${process.env["PATH"]}` }, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a release that fails to install is deleted and the old one never stops", () => {
    const s = setup();
    expect(deploy(s, pack("aaaaaaa")).status).toBe(0);
    writeFileSync(join(s.stubs, "bun"), "#!/usr/bin/env bash\nexit 1\n");

    const { status, commands } = deploy(s, pack("bbbbbbb"));

    expect(status).toBe(1);
    expect(current(s)).toBe(join(s.releases, "aaaaaaa"));
    expect(releaseNames(s)).toEqual(["aaaaaaa"]);
    expect(commands.filter((line) => line.startsWith("systemctl"))).toEqual([]);
  });

  describe("error reporting (PS-227)", () => {
    const DSN = "https://publickey@o1.ingest.example/42";

    test("with no DSN the secrets are copied as they are", () => {
      const s = setup();
      expect(deploy(s, pack("aaaaaaa")).status).toBe(0);
      expect(varsOf(join(s.releases, "aaaaaaa"))).toBe("IMAGE_SIGNING_SECRET=ct-secret\n");
    });

    test("a DSN the CT holds gets the release's sha and the lan environment", () => {
      const s = setup();
      writeFileSync(
        join(s.legacyWeb, ".dev.vars.e2e"),
        `IMAGE_SIGNING_SECRET=ct-secret\nSENTRY_DSN=${DSN}\n`,
      );
      const { status, stderr, commands } = deploy(s, pack("abc1234"));
      const rel = join(s.releases, "abc1234");

      expect(status).toBe(0);
      expect(varsOf(rel).split("\n").toSorted()).toEqual(
        [
          "",
          "IMAGE_SIGNING_SECRET=ct-secret",
          `SENTRY_DSN=${DSN}`,
          "SENTRY_ENVIRONMENT=lan",
          "SENTRY_RELEASE=abc1234",
        ].toSorted(),
      );
      expect(statSync(join(rel, "apps/web/dist/server/.dev.vars")).mode & 0o777).toBe(0o600);
      // The shared secrets file is not stamped with a release: that is each release's own.
      expect(readFileSync(join(s.legacyWeb, ".dev.vars.e2e"), "utf8")).not.toContain(
        "SENTRY_RELEASE",
      );
      expect([stderr, ...commands].join("\n")).not.toContain(DSN);
    });

    test("a DSN carried in the tarball is saved for the next release, and printed nowhere", () => {
      const s = setup();
      const { status, stderr, commands } = deploy(s, pack("aaaaaaa", { sentryDsn: DSN }));

      expect(status).toBe(0);
      expect(readFileSync(join(s.legacyWeb, ".dev.vars.e2e"), "utf8")).toContain(
        `SENTRY_DSN=${DSN}`,
      );
      expect(statSync(join(s.legacyWeb, ".dev.vars.e2e")).mode & 0o777).toBe(0o600);
      expect(varsOf(join(s.releases, "aaaaaaa"))).toContain("SENTRY_RELEASE=aaaaaaa");
      expect(existsSync(join(s.releases, "aaaaaaa/.sentry-dsn"))).toBe(false);
      expect([stderr, ...commands].join("\n")).not.toContain(DSN);

      // The next release carries none, and reports as itself.
      expect(deploy(s, pack("bbbbbbb")).status).toBe(0);
      const next = varsOf(join(s.releases, "bbbbbbb"));
      expect(next).toContain(`SENTRY_DSN=${DSN}`);
      expect(next).toContain("SENTRY_RELEASE=bbbbbbb");
      expect(next).not.toContain("SENTRY_RELEASE=aaaaaaa");
    });
  });
});
