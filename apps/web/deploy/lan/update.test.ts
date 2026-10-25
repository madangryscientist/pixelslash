import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

// update.sh run against a real git checkout of a local bare origin. The root-only pieces are stubbed:
// `runuser` runs its command as this user, and `systemctl` and `journalctl` only log.
const SCRIPT = fileURLToPath(new URL("./update.sh", import.meta.url));
const REPO_PATH = "apps/web/deploy/lan/update.sh";
const MARK = 'echo "NEW BODY args: $*" >&2';

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args],
    {
      cwd,
      stdio: "pipe",
    },
  )
    .toString()
    .trim();
}

// Writes the files and commits them on main of `work`, then pushes to origin.
function commit(work: string, files: Record<string, string>, message: string) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), body);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", message);
  git(work, "push", "-q", "origin", "main");
}

// The script with a line added right after `set -Eeuo pipefail`: the new body announces itself.
const withMarker = (text: string) =>
  text.replace("set -Eeuo pipefail\n", `set -Eeuo pipefail\n${MARK}\n`);

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function setup() {
  root = mkdtempSync(join(tmpdir(), "update-sh-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const checkout = join(root, "checkout");
  const stubs = join(root, "stubs");
  const log = join(root, "systemctl.log");

  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  commit(work, { [REPO_PATH]: readFileSync(SCRIPT, "utf8"), "README.md": "v1\n" }, "initial");
  git(root, "clone", "-q", origin, checkout);

  mkdirSync(stubs);
  writeFileSync(
    join(stubs, "runuser"),
    '#!/usr/bin/env bash\nwhile [[ $1 != -- ]]; do shift; done\nshift\nexec "$@"\n',
  );
  // `stop` fails, so the run ends in the ERR trap's rollback before any install: nothing it reaches
  // needs bun or a real /home/pixelslash.
  writeFileSync(
    join(stubs, "systemctl"),
    '#!/usr/bin/env bash\necho "systemctl $* REEXEC=${PIXELSLASH_UPDATE_REEXEC:-}" >>"$STUB_LOG"\n[[ $1 != stop ]]\n',
  );
  writeFileSync(join(stubs, "journalctl"), "#!/usr/bin/env bash\nexit 0\n");
  for (const name of ["runuser", "systemctl", "journalctl"]) chmodSync(join(stubs, name), 0o755);

  return { origin, work, checkout, stubs, log };
}

// One run of the checkout's copy of update.sh. It ends at the stop, after every line this test is about.
function run(s: ReturnType<typeof setup>, guarded = false) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${s.stubs}:${process.env.PATH}`,
    PIXELSLASH_REPO: s.checkout,
    STUB_LOG: s.log,
  };
  delete childEnv.PIXELSLASH_UPDATE_REEXEC;
  if (guarded) childEnv.PIXELSLASH_UPDATE_REEXEC = "1";
  const result = spawnSync("bash", [join(s.checkout, REPO_PATH), "--flag", "value"], {
    env: childEnv,
    encoding: "utf8",
  });
  const stopLines = readLog(s.log).filter((line) =>
    line.startsWith("systemctl stop pixelslash-web "),
  );
  return { stderr: result.stderr, stopLines };
}

function readLog(path: string) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("update.sh self re-exec", () => {
  test("a commit that changes the script runs the new body once, with the same arguments", () => {
    const s = setup();
    const oldText = readFileSync(join(s.checkout, REPO_PATH), "utf8");
    commit(s.work, { [REPO_PATH]: withMarker(oldText) }, "change update.sh");

    const { stderr, stopLines } = run(s);
    const newText = readFileSync(join(s.checkout, REPO_PATH), "utf8");

    expect(newText).not.toBe(oldText);
    expect(
      stderr.match(/update\.sh changed \(sha256 ([0-9a-f]{64}) -> ([0-9a-f]{64})\)/)?.slice(1),
    ).toEqual([sha(oldText), sha(newText)]);
    expect(stderr.split("NEW BODY").length - 1).toBe(1);
    expect(stderr).toContain("NEW BODY args: --flag value");
    expect(stopLines).toEqual(["systemctl stop pixelslash-web REEXEC=1"]);
  });

  test("an unchanged script does not re-exec", () => {
    const s = setup();
    commit(s.work, { "README.md": "v2\n" }, "docs only");

    const { stderr, stopLines } = run(s);

    expect(stderr).not.toContain("update.sh changed");
    expect(stderr).not.toContain("NEW BODY");
    expect(stopLines).toEqual(["systemctl stop pixelslash-web REEXEC="]);
  });

  test("the guard stops a re-exec even when the script changed", () => {
    const s = setup();
    const oldText = readFileSync(join(s.checkout, REPO_PATH), "utf8");
    commit(s.work, { [REPO_PATH]: withMarker(oldText) }, "change update.sh");

    const { stderr, stopLines } = run(s, true);

    expect(stderr).not.toContain("update.sh changed");
    expect(stderr).not.toContain("NEW BODY");
    expect(stopLines).toEqual(["systemctl stop pixelslash-web REEXEC=1"]);
  });
});
