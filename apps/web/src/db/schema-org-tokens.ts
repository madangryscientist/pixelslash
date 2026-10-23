import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, orgs, users } from "./schema";

/* Beside `schema.ts`, which `drizzle.config.ts` reads with it. */

/**
 * An org's CI token (ob 1787): one secret that reaches every project of its org, which the
 * request names. Shown once at issue; only its SHA-256 and a display prefix are stored, as for
 * `ci_tokens`.
 */
export const orgTokens = sqliteTable(
  "org_tokens",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
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
  (t) => [index("org_tokens_org_idx").on(t.orgId)],
);
