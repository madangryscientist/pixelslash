import { sql } from "drizzle-orm";
import { integer } from "drizzle-orm/sqlite-core";

/** The `created_at` column every table carries. Beside `schema.ts`, which is at its line cap. */
export const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
