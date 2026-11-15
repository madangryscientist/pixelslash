import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, orgs, projects } from "./schema";

/* Model settings. Beside `schema.ts`, which `drizzle.config.ts` reads with it; `schema.ts` is at its line cap. */

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

/**
 * An org's own model (ob 1789): the same settings as `project_models`, used by every project of the
 * org that has no row of its own. The key is sealed exactly as the project's is (ob 1786), and only
 * `src/db/models.ts` reads it.
 */
export const orgModels = sqliteTable("org_models", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  apiKey: text("api_key").notNull(),
  autoPassNoise: integer("auto_pass_noise", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});
