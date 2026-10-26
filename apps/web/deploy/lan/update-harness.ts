import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { expect } from "vitest";

// update.sh, the CT-side half of a LAN deploy, run against temp directories. The root-only pieces
// are stubbed: `runuser` runs its command as this user; `systemctl`, `journalctl`, `bun` and `bunx`
// only log. `wait_for_port` is replaced after the script is sourced: :3000 never opens while
// `current` is a release holding a BROKEN file, which stands in for a serve.ts that exits. `bunx`
// answers `wrangler d1 execute` from a real SQLite file (the builds table the test fills), so the
// in-flight build check runs its real SQL; everything else it only logs.
const SCRIPT = fileURLToPath(new URL("./update.sh", import.meta.url));
const LAN = fileURLToPath(new URL(".", import.meta.url));
export const UNITS = [
  "pixelslash-stub.service",
  "pixelslash-diff.service",
  "pixelslash-web.service",
];

let root = "";
/** Remove the run's temp directory; each test file calls it from `afterEach`. */
export const cleanup = () => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
};

export function setup() {
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
  for (const name of ["systemctl", "journalctl", "bun"])
    stub(name, `echo "${name} $* @ $PWD" >>"$STUB_LOG"`);
  stub("bunx", bunxBody());

  const db = new Database(join(root, "d1.sqlite"));
  db.run("CREATE TABLE builds (id TEXT PRIMARY KEY, status TEXT, processing_started_at INTEGER)");
  const build = (id: string, status: string, startedAgoMs: number | null) =>
    db.run("INSERT INTO builds VALUES (?, ?, ?)", [
      id,
      status,
      startedAgoMs === null ? null : Date.now() - startedAgoMs,
    ]);

  return { build, home, legacyWeb, stubs, unitDir, log, releases: join(home, "releases") };
}

export type Setup = ReturnType<typeof setup>;

/** `bunx`: logs; and answers `wrangler d1 execute --command SQL` from $STUB_DB as wrangler's --json. */
export function bunxBody(rest = ""): string {
  return [
    'echo "bunx $* @ $PWD" >>"$STUB_LOG"',
    'if [[ " $* " == *" d1 execute "* ]]; then',
    '  sql=""; for ((i = 1; i <= $#; i++)); do [[ ${!i} == --command ]] && { j=$((i + 1)); sql=${!j}; }; done',
    `  exec "${process.execPath}" -e 'const {Database}=require("bun:sqlite");` +
      `console.log(JSON.stringify([{results:new Database(process.argv.at(-2)).query(process.argv.at(-1)).all(),success:true}]))' "$STUB_DB" "$sql"`,
    "fi",
    rest,
  ].join("\n");
}

// A release tarball as release.sh packs it, cut down to what update.sh touches.
export function pack(sha: string, { broken = false, sentryDsn = "" } = {}) {
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

export function deploy(s: Setup, tarball: string, env: Record<string, string> = {}) {
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
      STUB_DB: join(root, "d1.sqlite"),
      PATH: `${s.stubs}:${process.env["PATH"]}`,
      ...env,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stderr: result.stderr,
    commands: readFileSync(s.log, "utf8").split("\n").filter(Boolean),
  };
}

export const varsOf = (rel: string) =>
  readFileSync(join(rel, "apps/web/dist/server/.dev.vars"), "utf8");
export const current = (s: Setup) => readlinkSync(join(s.releases, "current"));
export const releaseNames = (s: Setup) =>
  readdirSync(s.releases)
    .filter((name) => name !== "current")
    .toSorted();
