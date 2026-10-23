import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import type {
  AiReview,
  AiSummary,
  DiffOptions,
  DiffRegion,
  DiffResult,
  IgnoreRect,
  ResolvedDiff,
} from "./diff-json";
import { isSmoke } from "./synthetic";

export const createdAt = () =>
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

/**
 * Where a project's shots are diffed (ob 1727): `ci` runs the engine in the CLI and the server
 * checks and stores its results; `server` diffs at finalise. One per project, no per-shot fallback.
 */
export const DIFF_LOCATIONS = ["ci", "server"] as const;
export type DiffLocation = (typeof DIFF_LOCATIONS)[number];

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
    /**
     * Where its shots are diffed (ob 1727). The column default is what projects from before it get;
     * a new one takes the deployment's `DEFAULT_DIFF_LOCATION`. Set on the settings page.
     */
    diffLocation: text("diff_location", { enum: DIFF_LOCATIONS }).notNull().default("server"),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.orgId, t.name)],
);

/**
 * The project's own OpenAI-compatible vision model (ob 1473), which explains the changed regions.
 * No row, no model: shots go to no model the project did not name. A table of its own so the key
 * never rides along with a `projects` row to a page; only `src/db/models.ts` reads it.
 */
export const projectModels = sqliteTable("project_models", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  apiKey: text("api_key").notNull(),
  /** A shot whose every `change` region the model labels noise is accepted without a reviewer. */
  autoPassNoise: integer("auto_pass_noise", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

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
    /** The project model's summary of what changed (ob 1668); null when none was made. Text only. */
    aiSummary: text("ai_summary", { mode: "json" }).$type<AiSummary>(),
    createdAt: createdAt(),
  },
  (t) => [index("builds_project_idx").on(t.projectId, t.createdAt)],
);

export type * from "./diff-json";
export { AI_LABELS } from "./diff-json";

export const DIFF_STATUSES = ["changed", "new", "removed", "unchanged"] as const;
export const REVIEW_STATES = ["pending", "accepted", "rejected"] as const;

export type DiffStatus = (typeof DIFF_STATUSES)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];

/** What a flaky shot does to its build (ob 1724): wait for approval like any change, or be skipped. */
export const FLAKY_POLICIES = ["review", "skip"] as const;
export type FlakyPolicy = (typeof FLAKY_POLICIES)[number];

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
    /**
     * What the server diff measured with (ob 1495): the config's options above with the project's
     * review-UI overrides laid over them, and each value's source. Null on a shot measured with
     * `diff_options` as uploaded: a CI project's, or one measured before overrides existed.
     */
    resolvedDiff: text("resolved_diff", { mode: "json" }).$type<ResolvedDiff>(),
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
    /** Who measured `diff_result` (ob 1727): the CLI in CI, or the server. Null until measured, and on older rows. */
    measuredBy: text("measured_by", { enum: DIFF_LOCATIONS }),
    /** The engine version that measured it, beside `measured_by`. */
    engineVersion: text("engine_version"),
    /**
     * What a CI run sent with the shot, unchecked: one `{baselineId, status, diffResult, diffKey}`
     * per baseline it measured against. Finalise validates the one for the server's pick (ob 1727).
     */
    ciResults: text("ci_results", { mode: "json" }).$type<unknown>(),
    /**
     * Why the shot was not measured: a CI result was refused, or the server's diff of it threw (ob
     * 1738). Its build errored naming it, and a re-run measures it again.
     */
    diffError: text("diff_error"),
    reviewedBy: text("reviewed_by").references(() => users.id),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    /**
     * The shot's flaky policy from its uploaded config (`meta.flaky`, ob 1724): the config is the
     * source of truth, and nothing on the server overrides it. Null when none was sent: `review`.
     */
    flakyPolicy: text("flaky_policy", { enum: FLAKY_POLICIES }),
    /**
     * The open flake this shot was labelled with (ob 1724): detected in this run, marked by hand, or
     * already open for its key when it was uploaded. Null when the shot is not flaky. No foreign
     * key, like `carried_from`.
     */
    flakeId: text("flake_id"),
    /**
     * The shot against main (ob 1723), for the branch page's final review: measured once by the diff,
     * only on a non-default branch, against the newest accepted shot of another branch at the
     * merge-base. `main_baseline_key` is that shot's image, null when there is none (`new`).
     * `main_diff_status` null means not measured against main: a default-branch build, a row older
     * than these columns, a changed environment, or a CI project whose run sent no result for it.
     * The columns mirror `baseline_key`, `diff_key`, `diff_status` and `diff_result`, and reuse
     * them when the shot's own baseline already is that shot.
     */
    mainBaselineKey: text("main_baseline_key"),
    mainDiffKey: text("main_diff_key"),
    mainDiffStatus: text("main_diff_status", { enum: DIFF_STATUSES }),
    mainDiffResult: text("main_diff_result", { mode: "json" }).$type<DiffResult>(),
    /**
     * A sentence describing the change in words (ob 1723), for the change summary. The CLI's judge
     * (a local model) writes it with `upload --judge` (ob 1745), and the pages say so. It is shown
     * only: no review state, threshold or exit code reads it.
     */
    changeNote: text("change_note"),
    /** The project's model on each `change` region (ob 1473); null when no model explained one. */
    aiReview: text("ai_review", { mode: "json" }).$type<AiReview>(),
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
    /** When the flag was turned into a bench case (ob 1734); an edit to the flag clears it. */
    exportedAt: integer("exported_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    unique().on(t.snapshotId, t.createdBy),
    index("detection_flags_project_idx").on(t.projectId, t.createdAt),
  ],
);

export const FLAKE_STATUSES = ["open", "resolved"] as const;
export type FlakeStatus = (typeof FLAKE_STATUSES)[number];

/**
 * One build's evidence that a shot is flaky (ob 1724): the CLI captured it again and the captures
 * disagreed. Run 1 is the shot itself (`imageKey`); `captures` are the re-captures, run 2 onwards,
 * stored beside it. `regions` are where each differing run differed from run 1.
 */
export type FlakeEvidence = {
  buildId: string;
  snapshotId: string;
  imageKey: string;
  /** The re-captures that were stored, by run number; a part that was not a PNG is not. */
  captures: { run: number; key: string }[];
  runs: number;
  differed: number[];
  regions: { run: number; regions: DiffRegion[] }[];
  engineVersion: string;
  policy: FlakyPolicy;
  at: number;
};

/**
 * A snapshot key (name + variant) whose captures disagreed within one run, or that a reviewer
 * marked flaky by hand (ob 1724). Not a detection flag: a flag says the diff was wrong, a flake
 * says the page is. One row per key: a detection on another build appends to its evidence, and a
 * detection on a resolved one reopens it.
 */
export const flakes = sqliteTable(
  "flakes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    browser: text("browser").notNull(),
    viewport: text("viewport").notNull(),
    theme: text("theme").notNull(),
    status: text("status", { enum: FLAKE_STATUSES }).notNull().default("open"),
    evidence: text("evidence", { mode: "json" })
      .$type<FlakeEvidence[]>()
      .notNull()
      .default(sql`'[]'`),
    /** The note a reviewer marked it with by hand; null when the CLI detected it. */
    note: text("note"),
    /** The reviewer who marked it by hand; null when the CLI detected it. */
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolutionNote: text("resolution_note"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    unique().on(t.projectId, t.name, t.platform, t.browser, t.viewport, t.theme),
    index("flakes_project_idx").on(t.projectId, t.status),
  ],
);
