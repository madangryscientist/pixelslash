import { UsageError } from "@pixelslash/engine";
import { RemoteError, isObj, objects, str } from "./api.ts";
import { takeJson } from "./args.ts";
import {
  REMOTE_FLAGS,
  connect,
  resolveProject,
  type Remote,
  type RemoteDeps,
  type RemoteFlags,
} from "./remote.ts";
import type { Io } from "./run.ts";
import { readFlagPairs } from "./upload.ts";

const REMOTE = "[--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--json]";
export const BUILDS_USAGE = `pixelslash builds [--branch NAME] [--limit N] ${REMOTE}`;
export const BUILD_USAGE = `pixelslash build ID|latest [--branch NAME] ${REMOTE}\n\`latest\` is the newest build of the project (on --branch, if given).`;

/** The API's own cap on a page. */
const MAX_LIMIT = 100;

function parseLimit(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT)
    throw new UsageError(`--limit must be a whole number from 1 to ${MAX_LIMIT}`);
  return String(n);
}

/** Columns padded to their widest cell; the last is left ragged. */
function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const count = (counts: unknown, key: string): string =>
  isObj(counts) && typeof counts[key] === "number" ? String(counts[key]) : "-";

function buildRow(b: Record<string, unknown>): string[] {
  return [
    str(b.id),
    str(b.branch),
    str(b.commit_sha).slice(0, 7),
    str(b.status),
    count(b.counts, "to_review"),
    str(b.created_at),
  ];
}

const BUILD_HEAD = ["ID", "BRANCH", "COMMIT", "STATUS", "TO REVIEW", "CREATED"];

const FLAGS = [...REMOTE_FLAGS, "project", "branch", "limit"] as const;

/** `pixelslash builds`: the project's builds, newest first. `--json` is the API's reply as sent. */
export async function runBuilds(argv: string[], io: Io, deps: RemoteDeps = {}): Promise<number> {
  const { json, rest } = takeJson(argv);
  const flags = readFlagPairs(rest, FLAGS);
  const limit = parseLimit(flags.limit);
  const remote = await connect(flags, deps);
  const project = await resolveProject(remote, flags.project);
  const reply = await remote.client.get(
    `/api/v1/projects/${encodeURIComponent(project.id)}/builds`,
    {
      branch: flags.branch,
      limit,
    },
  );
  if (json) {
    io.stdout.write(`${reply.text}\n`);
    return 0;
  }
  const builds = objects(reply.body.builds);
  const on = flags.branch ? ` on ${flags.branch}` : "";
  if (builds.length === 0) {
    io.stdout.write(`no builds in ${project.name}${on}\n`);
    return 0;
  }
  io.stdout.write(`${table([BUILD_HEAD, ...builds.map(buildRow)])}\n`);
  return 0;
}

const GROUPS = ["changed", "new", "removed", "unchanged", "rebaseline", "unmeasured"] as const;

function describeBuild(b: Record<string, unknown>): string {
  const pr = typeof b.pr_number === "number" ? `  PR #${b.pr_number}` : "";
  const lines = [
    `build ${str(b.id)}  ${str(b.status)}${b.error ? ` (${str(b.error)})` : ""}`,
    `${str(b.branch)} @ ${str(b.commit_sha).slice(0, 7)}${pr}  ${str(b.created_at)}`,
    `${GROUPS.map((g) => `${g} ${count(b.counts, g)}`).join(" · ")} · to review ${count(b.counts, "to_review")}`,
    str(b.web_url),
  ];
  const shots = objects(b.snapshots).map((s) => [
    str(s.name),
    str(s.viewport),
    str(s.theme),
    str(s.group),
    str(s.review_state),
  ]);
  if (shots.length > 0)
    lines.push("", table([["SNAPSHOT", "VIEWPORT", "THEME", "GROUP", "REVIEW"], ...shots]));
  return `${lines.join("\n")}\n`;
}

/** The newest build of the resolved project, on `--branch` when given. */
async function latestId(remote: Remote, flags: RemoteFlags & { branch?: string }): Promise<string> {
  const project = await resolveProject(remote, flags.project);
  const path = `/api/v1/projects/${encodeURIComponent(project.id)}/builds`;
  const list = await remote.client.get(path, { branch: flags.branch, limit: "1" });
  const newest = objects(list.body.builds)[0];
  const on = flags.branch ? ` on ${flags.branch}` : "";
  if (!newest) throw new RemoteError(`no builds in ${project.name}${on}`);
  return str(newest.id);
}

/** `pixelslash build ID|latest`: one build and its snapshots. `--json` is the API's reply as sent. */
export async function runBuild(argv: string[], io: Io, deps: RemoteDeps = {}): Promise<number> {
  const [ref, ...more] = argv;
  if (!ref || ref.startsWith("--")) throw new UsageError("need a build ID or `latest`");
  const { json, rest } = takeJson(more);
  const flags = readFlagPairs(
    rest,
    FLAGS.filter((f) => f !== "limit"),
  );
  if (ref !== "latest" && flags.branch) throw new UsageError("--branch goes with `latest`");
  const remote = await connect(flags, deps);
  const id = ref === "latest" ? await latestId(remote, flags) : ref;
  const reply = await remote.client.get(`/api/v1/builds/${encodeURIComponent(id)}`);
  if (json) {
    io.stdout.write(`${reply.text}\n`);
    return 0;
  }
  const { build } = reply.body;
  if (!isObj(build)) throw new RemoteError(`GET /api/v1/builds/${id}: no build in the answer`);
  io.stdout.write(describeBuild(build));
  return 0;
}
