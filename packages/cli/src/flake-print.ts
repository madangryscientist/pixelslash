import {
  CAUSE_WORDS,
  type CaptureConfig,
  type Repro,
  type ConfigEdit,
  type Suggestion,
  UsageError,
  parseConfig,
} from "@pixelslash/engine";
import { pathToFileURL } from "node:url";
import { firstLine } from "./account.ts";
import { isObj } from "./api.ts";
import type { FlakeRun } from "./flake.ts";
import type { Io } from "./run.ts";

/**
 * What `pixelslash flake` prints (ob 1725), and the config changes it suggests: previewed on a
 * copy, and written only when the user picks one at the terminal (`--write`). `--suggest`,
 * `--json` and the MCP tools preview and never write.
 */

function routeEntry(raw: Record<string, unknown>, config: CaptureConfig, name: string) {
  const i = config.routes.findIndex((r) => r.name === name);
  const routes = raw.routes;
  if (i < 0 || !Array.isArray(routes)) throw new UsageError(`the config has no route "${name}"`);
  const entry: unknown = routes[i];
  const obj = typeof entry === "string" ? { path: entry } : entry;
  if (!isObj(obj)) throw new UsageError(`config: routes[${i}] is not a route`);
  routes[i] = obj;
  return { where: `routes[${i}]`, entry: obj };
}

function child(parent: Record<string, unknown>, k: string): Record<string, unknown> {
  const v = parent[k];
  const obj = isObj(v) ? v : {};
  parent[k] = obj;
  return obj;
}

/** Apply `edit` to the raw JSON config in place; returns what it set, in the config's own paths. */
function applyEdit(raw: Record<string, unknown>, config: CaptureConfig, edit: ConfigEdit): string {
  if (edit.kind === "stabilise") {
    child(raw, "stabilise")[edit.key] = edit.value;
    return `stabilise.${edit.key} = ${JSON.stringify(edit.value)}`;
  }
  const { where, entry } = routeEntry(raw, config, edit.route);
  if (edit.kind === "flaky-skip") {
    entry.flaky = "skip";
    return `${where}.flaky = "skip"`;
  }
  const layer = child(child(entry, "variants"), edit.variant);
  const ignore = Array.isArray(layer.ignore) ? layer.ignore : [];
  layer.ignore = [...ignore, edit.rect];
  return `${where}.variants.${edit.variant}.ignore += ${JSON.stringify(edit.rect)}`;
}

export const askTerminal = async (question: string): Promise<string> => {
  if (!process.stdin.isTTY) return "";
  process.stderr.write(question);
  return firstLine();
};

/** A suggested config change, and exactly what it sets in the config's own paths (JSON only). */
type Preview = { n: number; text: string; edit: ConfigEdit; set: string | null };

/** Each suggestion that is a config change, previewed on a copy; the config is not touched. */
export async function previewEdits(
  path: string,
  config: CaptureConfig,
  fixes: Suggestion[],
): Promise<{ raw: Record<string, unknown> | undefined; previews: Preview[] }> {
  const edits = fixes.flatMap((s, i) => (s.edit ? [{ n: i + 1, text: s.text, edit: s.edit }] : []));
  if (!path.endsWith(".json"))
    return { raw: undefined, previews: edits.map((e) => ({ ...e, set: null })) };
  const raw: unknown = JSON.parse(await Bun.file(path).text());
  if (!isObj(raw)) throw new UsageError(`config: ${path} is not an object`);
  const previews = edits.map((e) => ({
    ...e,
    set: applyEdit(structuredClone(raw), config, e.edit),
  }));
  return { raw, previews };
}

/**
 * `--write`: list the suggestions that are config changes and write the one the user types, after
 * showing exactly what it sets. Nothing typed, or no terminal, writes nothing.
 */
async function offerEdits(
  target: { path: string; config: CaptureConfig; fixes: Suggestion[] },
  io: Io,
  ask: (q: string) => Promise<string>,
): Promise<void> {
  const { path, config, fixes } = target;
  const { raw, previews } = await previewEdits(path, config, fixes);
  if (previews.length === 0) {
    io.stdout.write("--write: none of these is a config change; nothing written\n");
    return;
  }
  if (!raw) {
    io.stdout.write(`--write: ${path} is not JSON, so it is not edited; add the change by hand\n`);
    return;
  }
  for (const p of previews) io.stdout.write(`  ${p.n}: ${p.set}\n`);
  const answer = (
    await ask(
      `Write which change to ${path}? It is rewritten as 2-space JSON. Type ${previews.map((p) => p.n).join(" or ")}, or nothing to leave it: `,
    )
  ).trim();
  const picked = previews.find((p) => String(p.n) === answer);
  if (!picked) {
    io.stdout.write(
      answer === "" ? "nothing written\n" : `"${answer}" is not one of them; nothing written\n`,
    );
    return;
  }
  applyEdit(raw, config, picked.edit);
  parseConfig(raw);
  await Bun.write(path, `${JSON.stringify(raw, null, 2)}\n`);
  io.stdout.write(
    `wrote ${picked.set} to ${path}; run \`pixelslash flake ID\` again to see if it holds\n`,
  );
}

/** `--suggest`: each change and what it would set; nothing is written. */
async function printPreviews(
  target: { path: string; config: CaptureConfig; fixes: Suggestion[] },
  io: Io,
): Promise<void> {
  const { raw, previews } = await previewEdits(target.path, target.config, target.fixes);
  for (const p of previews) io.stdout.write(`  ${p.n}: ${p.set ?? "add it by hand"}\n`);
  if (previews.length > 0)
    io.stdout.write(`nothing written${raw ? "; --write writes the one you pick" : ""}\n`);
}

function printRepro(repro: Repro, io: Io): void {
  for (const r of repro.runs.slice(1)) {
    const causes = r.causes.map((c) => CAUSE_WORDS[c]).join(", ");
    io.stdout.write(
      `run ${r.run}: ${r.differed ? "differed" : "same"}${causes ? ` (${causes})` : ""}\n`,
    );
    for (const g of r.regions)
      io.stdout.write(
        `  ${CAUSE_WORDS[g.kind]}: ${g.w}x${g.h} at ${g.x},${g.y} (${g.changedPixels} px)\n`,
      );
  }
  const n = repro.runs.length;
  io.stdout.write(
    repro.stable
      ? `stable: all ${n} runs rendered the same\n`
      : `unstable: ${repro.differed.length} of ${n - 1} runs differed from run 1\n`,
  );
}

function printFixes(fixes: Suggestion[], report: string, io: Io): void {
  if (fixes.length > 0) io.stdout.write("what to change:\n");
  for (const [i, s] of fixes.entries())
    io.stdout.write(`  ${i + 1}. ${s.text}${s.edit ? " [--write]" : ""}\n`);
  io.stdout.write(`report: ${pathToFileURL(report).href}\n`);
}

/** The run for a person: each run, what to change, and what `--suggest` or `--write` did. */
export async function printRun(
  r: FlakeRun,
  opts: { suggest: boolean; write: boolean },
  io: Io,
  ask: (q: string) => Promise<string>,
): Promise<void> {
  printRepro(r.repro, io);
  printFixes(r.fixes, r.report, io);
  const target = { path: r.configPath, config: r.config, fixes: r.fixes };
  if (opts.suggest) await printPreviews(target, io);
  if (!r.repro.stable && opts.write) await offerEdits(target, io, ask);
}

/** What `--resolve` did, after the run is printed so a refused resolve still shows the run. */
export function printResolved(r: FlakeRun, resolved: boolean, io: Io): void {
  if (resolved) io.stdout.write(`resolved ${r.id} on ${r.remote.client.server}\n`);
  else io.stdout.write("not resolved: the shot is still unstable here\n");
}
