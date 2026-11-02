import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, projects } from "./schema";

/* PR comments. Beside `schema.ts`, which `drizzle.config.ts` reads with it; `schema.ts` is at its line cap. */

/**
 * The one PixelSlash comment on a pull request (PS-82), edited in place by each new build of the
 * PR. Keyed by project and PR number; a project moved to another repo forgets its comments.
 */
export const prComments = sqliteTable(
  "pr_comments",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    /** GitHub's id of the comment. */
    commentId: integer("comment_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.prNumber] })],
);
