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

export const BUILD_STATUSES = [
  "uploading",
  "processing",
  "changes",
  "passed",
  "failed",
  "errored",
] as const;

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
    createdAt: createdAt(),
  },
  (t) => [index("builds_project_idx").on(t.projectId, t.createdAt)],
);

/** The diff tolerance a snapshot is compared with; the same keys as the engine's `DiffOptions`. */
export type DiffOptions = {
  threshold?: number;
  minChangedPixels?: number;
  minChangedRatio?: number;
};

export const DIFF_STATUSES = ["changed", "new", "removed", "unchanged"] as const;
export const REVIEW_STATES = ["pending", "accepted", "rejected"] as const;

/**
 * A name + a fixed variant (platform, browser, viewport, theme). Images live in the blob
 * store under the org's prefix; these are their keys. `diffStatus` is null until diffed.
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
    envFingerprint: text("env_fingerprint").notNull(),
    imageKey: text("image_key").notNull(),
    baselineKey: text("baseline_key"),
    diffKey: text("diff_key"),
    diffStatus: text("diff_status", { enum: DIFF_STATUSES }),
    reviewState: text("review_state", { enum: REVIEW_STATES }).notNull().default("pending"),
    reviewedBy: text("reviewed_by").references(() => users.id),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.buildId, t.name, t.platform, t.browser, t.viewport, t.theme),
    index("snapshots_build_idx").on(t.buildId),
  ],
);
