import type { NewBuild, SnapshotInput } from "#/db/builds";
import type { DiffOptions } from "#/db/schema";

/** A request the client got wrong: surfaces as a 400 with this message. */
export class BadRequest extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(where: string, what: string): never {
  throw new BadRequest(`${where} ${what}`);
}

function text(v: unknown, where: string, max: number, pattern?: RegExp): string {
  if (typeof v !== "string" || v === "" || v.length > max)
    bad(where, `must be a non-empty string of at most ${max} characters`);
  if (pattern && !pattern.test(v)) bad(where, "has characters it may not use");
  return v;
}

/** A git object id: SHA-1 (40) or SHA-256 (64) hex. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TOKEN = /^[\w.-]+$/;
export const MAX_ANCESTORS = 20;
const MAX_TAGS = 50;

function sha(v: unknown, where: string): string {
  if (typeof v !== "string" || !SHA.test(v)) bad(where, "must be a lowercase hex git SHA");
  return v;
}

export function object(v: unknown, where: string): Obj {
  if (!isObj(v)) bad(where, "must be an object");
  return v;
}

export function parseNewBuild(raw: unknown): NewBuild {
  const b = object(raw, "body");
  const ancestors = b.ancestorShas ?? [];
  if (!Array.isArray(ancestors) || ancestors.length > MAX_ANCESTORS)
    bad("ancestorShas", `must be an array of at most ${MAX_ANCESTORS} SHAs`);
  const pr = b.prNumber ?? null;
  if (pr !== null && (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0))
    bad("prNumber", "must be a positive integer");
  return {
    commitSha: sha(b.commitSha, "commitSha"),
    branch: text(b.branch, "branch", 255),
    mergeBaseSha: b.mergeBaseSha == null ? null : sha(b.mergeBaseSha, "mergeBaseSha"),
    ancestorShas: ancestors.map((s, i) => sha(s, `ancestorShas[${i}]`)),
    prNumber: pr,
  };
}

/** The engine's `DiffOptions` keys and what each takes: a 0 to 1 share, or a count. A key not listed is refused. */
const DIFF_KINDS: Record<keyof DiffOptions, "share" | "count"> = {
  threshold: "share",
  minChangedPixels: "count",
  minChangedRatio: "share",
};

function isDiffKey(k: string): k is keyof DiffOptions {
  return Object.hasOwn(DIFF_KINDS, k);
}

function diffValue(key: keyof DiffOptions, value: unknown): number {
  const where = `diff.${key}`;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    bad(where, "must be a non-negative number");
  if (DIFF_KINDS[key] === "count" && !Number.isInteger(value)) bad(where, "must be an integer");
  if (DIFF_KINDS[key] === "share" && value > 1) bad(where, "must be a number from 0 to 1");
  return value;
}

/** Absent is `{}`: older clients send no `diff`. */
function parseDiff(v: unknown): DiffOptions {
  if (v === undefined) return {};
  const out: DiffOptions = {};
  for (const [key, value] of Object.entries(object(v, "diff"))) {
    if (!isDiffKey(key)) bad(`diff.${key}`, "is not a diff option");
    out[key] = diffValue(key, value);
  }
  return out;
}

export function parseSnapshotInput(raw: unknown): SnapshotInput {
  const m = object(raw, "meta");
  const tags = m.tags ?? [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS)
    bad("tags", `must be an array of at most ${MAX_TAGS} strings`);
  const fp = object(m.fingerprint, "fingerprint");
  const theme = m.theme;
  if (theme !== "light" && theme !== "dark") bad("theme", 'must be "light" or "dark"');
  return {
    name: text(m.name, "name", 200),
    platform: text(m.platform, "platform", 40, TOKEN),
    browser: text(m.browser, "browser", 40, TOKEN),
    viewport: text(m.viewport, "viewport", 11, /^\d{1,5}x\d{1,5}$/),
    theme,
    tags: tags.map((t, i) => text(t, `tags[${i}]`, 100)),
    diff: parseDiff(m.diff),
    fingerprint: {
      image: text(fp.image, "fingerprint.image", 300),
      browser: text(fp.browser, "fingerprint.browser", 300),
      fonts: text(fp.fonts, "fingerprint.fonts", 300),
    },
  };
}

export function parseFinalise(raw: unknown): number {
  const n = object(raw, "body").snapshots;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
    bad("snapshots", "must be a non-negative integer");
  return n;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
  return head.length === 8 && PNG_SIGNATURE.every((b, i) => head[i] === b);
}
