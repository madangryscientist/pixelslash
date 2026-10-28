/**
 * The CI-style check for `examples/playwright-node` (PS-237): pack both npm packages, copy the sample
 * into a temp dir outside the workspace, install the tarballs the way a user would, run its tests on
 * Node with no `bun` on PATH, then let `pixelslash upload` take the dir it wrote (against a stub server).
 * `bun scripts/check-example.ts`. Needs the network once (npm installs Playwright and the CLI's deps).
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { uploadStub } from "../packages/playwright/test/upload-stub.ts";

const root = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "ps-example-"));
const app = join(scratch, "app");

function run(cmd: string, args: string[], cwd: string, env = process.env): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? done(out) : fail(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${out}`)),
    );
  });
}

/** PATH without any directory that holds a `bun`, so the step under test cannot reach one. */
function pathWithoutBun(): string {
  const dirs = (process.env["PATH"] ?? "").split(delimiter);
  return dirs
    .filter((dir) => spawnSync(join(dir, "bun"), ["--version"], { stdio: "ignore" }).error)
    .join(delimiter);
}

try {
  const packs = (await run("bun", ["scripts/pack-npm.ts", join(scratch, "packs")], root))
    .trim()
    .split("\n");
  if (packs.length !== 2) throw new Error(`expected two tarballs, got: ${packs.join(", ")}`);

  cpSync(join(root, "examples/playwright-node"), app, {
    recursive: true,
    filter: (src) => !/node_modules|pixelslash-snapshots|test-results/.test(src),
  });
  console.log("install: the two tarballs and the sample's own dependencies");
  await run("npm", ["install", "--no-audit", "--no-fund", ...packs], app);
  await run("npx", ["playwright", "install", "chromium-headless-shell"], app);

  // From here to the upload, no `bun`: this is the machine of a team that runs Node.
  const nodeOnly = { ...process.env, PATH: pathWithoutBun() };
  if (!spawnSync("bun", ["--version"], { env: nodeOnly }).error)
    throw new Error("bun is still on PATH for the Node-only steps");
  console.log("typecheck: the spec against the shipped declarations");
  await run("npx", ["tsc", "--noEmit"], app, nodeOnly);
  console.log("test: npx playwright test, Node only");
  console.log(await run("npx", ["playwright", "test"], app, nodeOnly));

  // Upload (the CLI is a Bun program) from a git repo on main, to a stub of the upload API.
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  await run("git", ["init", "-q", "-b", "main"], repo);
  const author = ["-c", "user.name=t", "-c", "user.email=t@t"];
  await run("git", [...author, "commit", "-q", "--allow-empty", "-m", "m0"], repo);
  const stub = uploadStub();
  const server = await stub.ready();
  try {
    const cli = join(app, "node_modules/@hackcove/pixelslash/dist/index.js");
    const flags = ["--server", server, "--branch", "ci", "--flake-retries", "0"];
    const env = { ...process.env, PIXELSLASH_TOKEN: "psci_test", HOME: scratch };
    console.log(
      await run("bun", [cli, "upload", join(app, "pixelslash-snapshots"), ...flags], repo, env),
    );
  } finally {
    await stub.stop();
  }
  const [shot] = stub.metas;
  if (stub.metas.length !== 1 || shot?.name !== "dashboard" || shot.ignore.length !== 1)
    throw new Error(`the upload did not carry the dashboard shot: ${JSON.stringify(stub.metas)}`);
  console.log(
    "ok: the Node-only run wrote a dir `pixelslash upload` accepted, with its ignore box",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
