import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import type { DiffOptions } from "./diff-json";
import { createdAt, projects, users } from "./schema";

/* Review-UI diff overrides (ob 1495). Beside `schema.ts`, which `drizzle.config.ts` reads with it. */

/**
 * A reviewer's diff options for one test (ob 1495), set in the review UI: a snapshot name, for every
 * variant (the four variant columns `""`) or for one. Laid over the config's options key by key, the
 * variant's over the test's; the next server diff of a matching shot reads them. `""` rather than
 * null so the unique key holds: SQLite treats every null as distinct.
 */
export const diffOverrides = sqliteTable(
  "diff_overrides",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").notNull().default(""),
    browser: text("browser").notNull().default(""),
    viewport: text("viewport").notNull().default(""),
    theme: text("theme").notNull().default(""),
    options: text("options", { mode: "json" }).$type<DiffOptions>().notNull(),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => users.id),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.projectId, t.name, t.platform, t.browser, t.viewport, t.theme)],
);

/**
 * The audit trail of `diff_overrides` (ob 1495): one row per change, who and when, the options
 * before and after. Null `before` is a new override, null `after` a cleared one. Kept when the
 * override itself is cleared.
 */
export const diffOverrideChanges = sqliteTable(
  "diff_override_changes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").notNull().default(""),
    browser: text("browser").notNull().default(""),
    viewport: text("viewport").notNull().default(""),
    theme: text("theme").notNull().default(""),
    before: text("before", { mode: "json" }).$type<DiffOptions>(),
    after: text("after", { mode: "json" }).$type<DiffOptions>(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("diff_override_changes_project_idx").on(t.projectId, t.at)],
);

/**
 * An ignore box drawn in the review UI (ob 1499): a rectangle in image px the server diff skips on
 * one test, for every variant (the four variant columns `""`) or for one. Unioned with the shot's
 * uploaded ignore areas. Clearing one stamps `cleared_*` rather than deleting it, so the row is
 * its own audit trail: who drew it and when, who cleared it and when.
 */
export const ignoreBoxes = sqliteTable(
  "ignore_boxes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").notNull().default(""),
    browser: text("browser").notNull().default(""),
    viewport: text("viewport").notNull().default(""),
    theme: text("theme").notNull().default(""),
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    clearedBy: text("cleared_by").references(() => users.id),
    clearedAt: integer("cleared_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("ignore_boxes_project_idx").on(t.projectId, t.name)],
);
