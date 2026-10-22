import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { isSmoke } from "./synthetic";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  githubId: integer("github_id").notNull().unique(),
  login: text("login").notNull().unique(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: createdAt(),
});

/** The session cookie holds a random token; only its SHA-256 is stored, as `id`. */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
});

/** A smoke org's builds and snapshots are synthetic: usage counts exclude them (`real()`). */
export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
  isSmoke: isSmoke(),
});

export const members = sqliteTable(
  "members",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("members_user_idx").on(t.userId)],
);

/** An invite names a GitHub login (lowercased); it becomes a membership when that user signs in. */
export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    githubLogin: text("github_login").notNull(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.orgId, t.githubLogin), index("invites_login_idx").on(t.githubLogin)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Builds on this branch are auto-accepted and become the next baselines (ob 1559). Set on the settings page. */
    defaultBranch: text("default_branch").notNull().default("main"),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.orgId, t.name)],
);

/** A CI token is shown once at issue; only its SHA-256 and a display prefix are stored. */
export const ciTokens = sqliteTable(
  "ci_tokens",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("ci_tokens_project_idx").on(t.projectId)],
);

/**
 * A person's API token (ob 1728): the CLI and MCP act as its user, seeing what they see in the
 * web app. Shown once at issue; only its SHA-256 and a display prefix are stored, as for CI tokens.
 */
export const userTokens = sqliteTable(
  "user_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    /** Null never expires. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("user_tokens_user_idx").on(t.userId)],
);

export const BUILD_STATUSES = [
  "uploading",
  "processing",
  "changes",
  "passed",
  "failed",
  "errored",
] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

/**
 * One upload for one project at one commit. `ancestorShas` feed the baseline pick.
 * `uploading` is the only mutable status: finalising moves it on, and nothing moves it back.
 */
export const builds = sqliteTable(
  "builds",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    branch: text("branch").notNull(),
    mergeBaseSha: text("merge_base_sha"),
    ancestorShas: text("ancestor_shas", { mode: "json" }).$type<string[]>().notNull().default([]),
    prNumber: integer("pr_number"),
    status: text("status", { enum: BUILD_STATUSES }).notNull().default("uploading"),
    /** Why processing ended in `errored`; null otherwise. Never a guess at a diff. */
    error: text("error"),
    /**
     * When a diff run claimed this build; null until one does. A run that is killed mid-diff
     * cannot write `errored`, so this is how a `processing` build is told from a dead one.
     */
    processingStartedAt: integer("processing_started_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("builds_project_idx").on(t.projectId, t.createdAt)],
);

/** The diff tolerance a snapshot is compared with; the same keys as the engine's `DiffOptions`. */
export type DiffOptions = {
  threshold?: number;
  minChangedPixels?: number;
  minChangedRatio?: number;
  mergeDistance?: number;
  minRegionArea?: number;
  noiseAmplitude?: number;
  maxShift?: number;
};

/** A rectangle in image px that the diff skips; the same shape as the engine's `IgnoreRect`. */
export type IgnoreRect = { x: number; y: number; width: number; height: number };

export type RegionKind = "change" | "noise" | "shift";

/** A box of differing pixels, the same shape as the engine's `Region` (ob 1486, 1487). */
export type DiffRegion = {
  x: number;
  y: number;
  w: number;
  h: number;
  changedPixels: number;
  antialiasedPixels: number;
  /** Only `change` blocks a build; a `noise` or `shift` box is kept for the reviewer. */
  kind: RegionKind;
  why?: string;
};

/**
 * What the diff measured for one snapshot, as stored. `null` means it was not compared: no
 * baseline (`new`), a removed shot, or a fingerprint that needs a re-baseline.
 */
export type DiffResult = {
  changedPixels: number;
  antialiasedPixels: number;
  /** Pixels of the overlap inside an ignore area: skipped, so neither changed nor unchanged. */
  ignoredPixels: number;
  ignored: IgnoreRect[];
  /** Boxes dropped below `minRegionArea`: counted, never silently lost. */
  specks: { count: number; pixels: number };
  regions: DiffRegion[];
  /** The overlap that was measured; `main*` and `branch*` are both shots, which may differ. */
  width: number;
  height: number;
  mainWidth: number;
  mainHeight: number;
  branchWidth: number;
  branchHeight: number;
  /** The shots are different sizes: `changed`, and only the overlap was measured. */
  sizeChanged: boolean;
};

export const DIFF_STATUSES = ["changed", "new", "removed", "unchanged"] as const;
export const REVIEW_STATES = ["pending", "accepted", "rejected"] as const;

export type DiffStatus = (typeof DIFF_STATUSES)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];

/**
 * A name + a fixed variant (platform, browser, viewport, theme). Images live in the blob
 * store under the org's prefix; these are their keys. `diffStatus` is null until diffed.
 *
 * A `removed` row is a marker, not an upload: it keeps the baseline build's blob as both
 * `image_key` and `baseline_key` so a reviewer can still see what went away, so it names bytes it
 * does not own. `diff_result` is null on it. Whether a row is a marker is decided in `markers.ts`
 * (`isMarker`, `heldShot`); every query that counts, bills or picks a baseline goes through it
 * rather than testing `diff_status` itself (ob 1558).
 *
 * Retention: no cleanup deletes blobs yet. One that deletes a build's blobs must keep every key a
 * row of another build still names as its `baseline_key` (which covers every marker), and every
 * key of a shot a later build could still pick as a baseline.
 */
export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    buildId: text("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    browser: text("browser").notNull(),
    viewport: text("viewport").notNull(),
    theme: text("theme").notNull(),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** Resolved from the customer's capture config at upload; `{}` means the engine defaults. */
    diffOptions: text("diff_options", { mode: "json" })
      .$type<DiffOptions>()
      .notNull()
      .default(sql`'{}'`),
    /** Areas the diff skips (kept visible in the PNG); `[]` means everything is measured. */
    ignore: text("ignore", { mode: "json" })
      .$type<IgnoreRect[]>()
      .notNull()
      .default(sql`'[]'`),
    envFingerprint: text("env_fingerprint").notNull(),
    imageKey: text("image_key").notNull(),
    baselineKey: text("baseline_key"),
    diffKey: text("diff_key"),
    diffStatus: text("diff_status", { enum: DIFF_STATUSES }),
    /** What the diff measured; null when the shot was not compared (see `DiffResult`). */
    diffResult: text("diff_result", { mode: "json" }).$type<DiffResult>(),
    /** The baseline's environment differs: needs a new baseline, measured against nothing. */
    rebaselineNeeded: integer("rebaseline_needed", { mode: "boolean" }).notNull().default(false),
    reviewState: text("review_state", { enum: REVIEW_STATES }).notNull().default("pending"),
    /**
     * Set on a shot the diff found unchanged against the same branch's previous shot while that
     * one's change was still undecided (ob 1712): the id of the shot that holds the change, as
     * measured against the accepted baseline. The change stays open here too, so the shot blocks
     * until it is decided, and a decision on either applies to both. No foreign key: a reader
     * treats a missing one as gone.
     */
    carriedFrom: text("carried_from"),
    /**
     * The shot this one was compared against (ob 1722): set by the diff from the baseline pick, null
     * when it was compared against nothing and on rows diffed before it existed. Provenance only,
     * read for display (`approvedEarlier` in `review.ts`); no foreign key, like `carried_from`.
     */
    baselineSnapshotId: text("baseline_snapshot_id"),
    reviewedBy: text("reviewed_by").references(() => users.id),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.buildId, t.name, t.platform, t.browser, t.viewport, t.theme),
    index("snapshots_build_idx").on(t.buildId),
    index("snapshots_carried_idx").on(t.carriedFrom),
  ],
);

export const FLAG_KINDS = ["missed", "false_positive"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

/**
 * A reviewer's word that the diff got a shot wrong (ob 1721): a change it `missed`, or a
 * `false_positive` it flagged. One per user per snapshot. It is not a review decision: it never
 * accepts, rejects or re-diffs, and a decision never clears it. What the diff measured is copied in
 * at flag time, so the list stays the detector's work list even if the diff is rerun later.
 */
export const detectionFlags = sqliteTable(
  "detection_flags",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: FLAG_KINDS }).notNull(),
    note: text("note"),
    /** Where on the shot, in image px: the ignore-area shape. Null when the flag names no area. */
    rect: text("rect", { mode: "json" }).$type<IgnoreRect>(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    unique().on(t.snapshotId, t.createdBy),
    index("detection_flags_project_idx").on(t.projectId, t.createdAt),
  ],
);
