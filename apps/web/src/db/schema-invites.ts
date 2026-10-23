import { index, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { createdAt, orgs, users } from "./schema";

/* Org invites. Beside `schema.ts`, which `drizzle.config.ts` reads with it; `schema.ts` is at its line cap. */

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
