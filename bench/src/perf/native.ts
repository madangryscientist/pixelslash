#!/usr/bin/env bun
/**
 * `diff.wasm`'s steps timed in wasm and in the same Rust built for the host (PS-212), on the perf
 * pages. It answers "is the gap to C# wasm's, or the code's": a step that is slow in both is ours
 * to fix in `lib.rs`, and one that is slow only in wasm is the runtime's.
 *
 *   bun run bench:native [--runs 10] [--wasm <module>]
 *
 * Both sides run the same steps on the same inflated rows (inflate is the runtime's zlib, outside
 * both): copy the rows in, unfilter, the pixel loop, the blob boxes. Each side's first run on a
 * fresh instance is reported apart from the median of the warm runs after it, because the first
 * pays for growing the memory. It checks that both sides found the same: the counts and an FNV-1a
 * of each image, the field, the overlay and the boxes. Needs `cargo` (`mise exec rust@1.99.1 --`),
 * like `wasm:build`; on demand only, never in the gate. `--wasm` times another build of the
 * module, for an A/B of a change to `lib.rs`.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { say, warn } from "../say.ts";
import { DIFF_SIZES, branchFile, mainFile, writeFixtures } from "./fixtures.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CRATE = join(ROOT, "engines/wasm/native");
const MODULE = join(ROOT, "packages/engine/wasm/diff.wasm");

const STEPS = ["copy", "decode_unfilter", "pixel_compare", "blob_boxes"] as const;
type Times = Record<(typeof STEPS)[number], number>;
type Side = { warm: Times; first: Times; found: Record<string, unknown> };

/** The defaults the engine diffs with: threshold 0.01, merge distance 24. */
const MAX_DELTA = 35215 * 0.01 * 0.01;
const GAP = 24;

type Shot = { width: number; height: number; channels: number; rows: Buffer };

/** The 8-bit RGB or RGBA PNG's shape and inflated rows; the perf pages are all of that kind. */
function inflated(png: Buffer): Shot {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT")
      idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  return { width, height, channels, rows: inflateSync(Buffer.concat(idat)) };
}

/** The pair as `diff-native` reads it. */
function dump(pair: Shot[]): Buffer {
  return Buffer.concat(
    pair.flatMap((s) => {
      const head = Buffer.alloc(12);
      head.writeUInt32LE(s.width, 0);
      head.writeUInt32LE(s.height, 4);
      head.writeUInt32LE(s.channels, 8);
      return [head, s.rows];
    }),
  );
}

type Exports = {
  memory: WebAssembly.Memory;
  reset(): void;
  mark(): number;
  rewind(to: number): void;
  alloc(len: number): number;
  unfilter(src: number, w: number, h: number, channels: number, dst: number): number;
  diff(...args: number[]): void;
  blob_boxes(kind: number, w: number, h: number, gap: number, out: number): number;
};

const EXPORTS = ["reset", "mark", "rewind", "alloc", "unfilter", "diff", "blob_boxes"] as const;

function isExports(exports: WebAssembly.Instance["exports"]): exports is Exports {
  return (
    exports["memory"] instanceof WebAssembly.Memory &&
    EXPORTS.every((name) => typeof exports[name] === "function")
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTimes = (value: unknown): value is Times =>
  isRecord(value) && STEPS.every((step) => typeof value[step] === "number");

function fnv(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

/** One diff of the pair in `wasm`, as `diff-native` runs it. */
function wasmRun(wasm: Exports, pair: Shot[]): { times: Times; found: Record<string, unknown> } {
  const times: Times = { copy: 0, decode_unfilter: 0, pixel_compare: 0, blob_boxes: 0 };
  const at = (len: number) => {
    const ptr = wasm.alloc(len);
    if (ptr === 0) throw new Error("diff.wasm: memory is full");
    return ptr;
  };
  wasm.reset();
  const rgba = pair.map((s) => {
    const to = at(s.width * s.height * 4);
    const lines = wasm.mark();
    let started = performance.now();
    const raw = at(s.rows.length);
    new Uint8Array(wasm.memory.buffer, raw, s.rows.length).set(s.rows);
    times.copy += performance.now() - started;
    started = performance.now();
    if (wasm.unfilter(raw, s.width, s.height, s.channels, to) !== 0) throw new Error("unfilter");
    times.decode_unfilter += performance.now() - started;
    wasm.rewind(lines);
    return to;
  });
  const [a, b] = pair;
  const [ra = 0, rb = 0] = rgba;
  if (!a || !b) throw new Error("a pair is two shots");
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const n = w * h;
  const overlayLen = Math.max(a.width, b.width) * Math.max(a.height, b.height) * 4;
  const overlay = at(overlayLen);
  const field = at(n * 3);
  const out = at(16);
  let started = performance.now();
  wasm.diff(ra, a.width, a.height, rb, b.width, b.height, 0, MAX_DELTA, field, overlay, out);
  times.pixel_compare = performance.now() - started;
  started = performance.now();
  const count = wasm.blob_boxes(field, w, h, GAP, out + 8);
  times.blob_boxes = performance.now() - started;
  const mem = wasm.memory.buffer;
  const [changed, antialiased, boxes = 0] = new Uint32Array(mem, out, 3);
  const view = (ptr: number, len: number) => new Uint8Array(mem, ptr, len);
  const found = {
    changed,
    antialiased,
    boxes: count,
    rgba: [fnv(view(ra, a.width * a.height * 4)), fnv(view(rb, b.width * b.height * 4))],
    field: fnv(view(field, n * 3)),
    overlay: fnv(view(overlay, overlayLen)),
    box_bytes: fnv(view(boxes, count * 16)),
  };
  return { times, found };
}

const median = (values: number[]): number =>
  values.toSorted((x, y) => x - y)[values.length >> 1] ?? 0;

function wasmSide(module: WebAssembly.Module, pair: Shot[], runs: number): Side {
  const { exports: wasm } = new WebAssembly.Instance(module);
  if (!isExports(wasm)) throw new Error("the module does not export the diff");
  const first = wasmRun(wasm, pair);
  const samples = Array.from({ length: runs }, () => wasmRun(wasm, pair).times);
  const of = (step: (typeof STEPS)[number]) => median(samples.map((t) => t[step]));
  const warm: Times = {
    copy: of("copy"),
    decode_unfilter: of("decode_unfilter"),
    pixel_compare: of("pixel_compare"),
    blob_boxes: of("blob_boxes"),
  };
  return { warm, first: first.times, found: first.found };
}

function nativeSides(paths: string[], runs: number): Side[] {
  const cargo = Bun.spawnSync(["cargo", "build", "--release", "--quiet"], {
    cwd: CRATE,
    stderr: "inherit",
  });
  if (cargo.exitCode !== 0) throw new Error(`cargo build exited ${cargo.exitCode}`);
  const bin = join(CRATE, "target/release/diff-native");
  const proc = Bun.spawnSync([bin, String(runs), ...paths], { stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`diff-native exited ${proc.exitCode}`);
  return proc.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => {
      const raw: unknown = JSON.parse(line);
      if (!isRecord(raw)) throw new Error(`diff-native: ${line}`);
      const { warm, first, pair: _, ...found } = raw;
      if (!isTimes(warm) || !isTimes(first)) throw new Error(`diff-native: ${line}`);
      return { warm, first, found };
    });
}

const fmt = (ms: number): string => ms.toFixed(1);

function table(page: string, wasm: Side, native: Side): string {
  const same = JSON.stringify(wasm.found) === JSON.stringify(native.found);
  const rows = STEPS.map(
    (s) =>
      `| ${s} | ${fmt(wasm.warm[s])} | ${fmt(native.warm[s])} | ${fmt(wasm.first[s])} | ${fmt(native.first[s])} |`,
  );
  const total = (t: Times) => STEPS.reduce((sum, s) => sum + t[s], 0);
  return [
    `${page}: ${same ? "same result" : "RESULTS DIFFER"} (${JSON.stringify(wasm.found)})`,
    "",
    "| step | wasm warm | native warm | wasm first | native first |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows,
    `| total | ${fmt(total(wasm.warm))} | ${fmt(total(native.warm))} | ${fmt(total(wasm.first))} | ${fmt(total(native.first))} |`,
    "",
  ].join("\n");
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}

function main(argv: string[]): number {
  const runs = Number(flag(argv, "--runs") ?? 10);
  const modulePath = flag(argv, "--wasm") ?? MODULE;
  const dir = mkdtempSync(join(tmpdir(), "ps-native-"));
  try {
    writeFixtures(dir);
    const module = new WebAssembly.Module(readFileSync(modulePath));
    const pages = Object.keys(DIFF_SIZES);
    const pairs = pages.map((page) =>
      [mainFile(page), branchFile(page)].map((f) => inflated(readFileSync(join(dir, f)))),
    );
    const paths = pairs.map((pair, i) => {
      const path = join(dir, `${pages[i]}.raw`);
      writeFileSync(path, dump(pair));
      return path;
    });
    const wasm = pairs.map((pair) => wasmSide(module, pair, runs));
    const native = nativeSides(paths, runs);
    say(`wasm: ${modulePath} · ${runs} warm runs, median ms\n`);
    const sides = pages.map((page, i) => {
      const [w, n] = [wasm[i], native[i]];
      if (!w || !n) throw new Error(`${page}: no result`);
      return { page, w, n };
    });
    for (const { page, w, n } of sides) say(table(page, w, n));
    return sides.every(({ w, n }) => JSON.stringify(w.found) === JSON.stringify(n.found)) ? 0 : 1;
  } catch (error) {
    warn(`native: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
