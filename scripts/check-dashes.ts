/**
 * Fails when a tracked text file holds an em dash (U+2014) or an en dash (U+2013). Run by the
 * `scripts` project's `check-dashes` target, which `lint` depends on, so `bun run lint` checks the
 * whole repo once. A hit names the file and line. Rewrite the sentence with a full stop, comma,
 * colon or brackets; a range uses "to"; an empty table cell reads `n/a`.
 *
 * The characters are built from their code points here so this file holds neither of them (the
 * formatter would turn a `\u` escape back into the character).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const DASH = new RegExp(`[${EN_DASH}${EM_DASH}]`, "u");

/**
 * Paths the check skips: files a tool writes, bench data, lockfiles and binary assets. A plain list
 * of globs, each with the reason it is not ours to edit. Everything else tracked is checked, so a
 * new text file is covered without being listed.
 */
export const EXCEPTIONS: readonly string[] = [
  // Generated: rewritten by their generator, so a hand edit would not survive the next run.
  "apps/web/worker-configuration.d.ts",
  "docs/capabilities/*.html",
  "**/routeTree.gen.ts",
  "**/*.gen.ts",
  "apps/web/drizzle/**",
  "**/*.lock",
  "**/package-lock.json",
  // Bench data: corpora, fixture pages (their text is the input under test), results, the Argos cache.
  "bench/corpus/**",
  "bench/corpus-holdout/**",
  "bench/fixtures*/**",
  "bench/results/**",
  "bench/argos-cache.json",
  "bench/argos-cache/**",
  // Binary assets, which git grep would match by accident.
  "**/*.{png,jpg,jpeg,gif,webp,ico,woff,woff2,wasm}",
];

const globs = EXCEPTIONS.map((pattern) => new Bun.Glob(pattern));

export function isExcepted(path: string): boolean {
  return globs.some((glob) => glob.match(path));
}

/** The dash hits in one file's text, as `path:line: ...` messages. */
export function scanText(path: string, text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    const match = DASH.exec(line);
    if (!match) return;
    const name = match[0] === EM_DASH ? "em dash (U+2014)" : "en dash (U+2013)";
    hits.push(
      `${path}:${i + 1}: ${name}; use a full stop, comma, colon or brackets ("to" for a range, "n/a" for an empty cell)`,
    );
  });
  return hits;
}

/** Scans `paths` (repo-relative), skipping the exceptions, binary files and files that are gone. */
export function scanFiles(
  paths: readonly string[],
  read: (path: string) => Buffer | null,
): string[] {
  const hits: string[] = [];
  for (const path of paths) {
    if (isExcepted(path)) continue;
    const bytes = read(path);
    if (bytes === null || bytes.includes(0)) continue;
    hits.push(...scanText(path, bytes.toString("utf8")));
  }
  return hits;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (listed.exitCode !== 0) {
    console.error(`check-dashes: git ls-files failed: ${listed.stderr.toString()}`);
    process.exit(2);
  }
  const paths = listed.stdout.toString().split("\0").filter(Boolean);
  const hits = scanFiles(paths, (path) => {
    try {
      return readFileSync(join(root, path));
    } catch {
      return null;
    }
  });
  if (hits.length > 0) {
    console.error(hits.join("\n"));
    console.error(`check-dashes: ${hits.length} line(s) with an em or en dash`);
    process.exit(1);
  }
}
