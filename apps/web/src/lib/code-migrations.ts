import journal from "../../drizzle/meta/_journal.json";

/**
 * The migration files the code carries, named as wrangler records them in `d1_migrations`
 * (`0034_tearful_eddie_brock.sql`). Read from drizzle's journal, which `db:generate` keeps in step
 * with the `.sql` files, so the Worker bundle carries a list of names and not the SQL.
 */
export const CODE_MIGRATIONS: readonly string[] = journal.entries.map(
  (entry) => `${entry.tag}.sql`,
);
