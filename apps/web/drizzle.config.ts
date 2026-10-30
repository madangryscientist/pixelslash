import { defineConfig } from "drizzle-kit";

// `bunx drizzle-kit generate` only; migrations apply with `wrangler d1 migrations apply`.
export default defineConfig({
  dialect: "sqlite",
  schema: [
    "./src/db/schema.ts",
    "./src/db/schema-overrides.ts",
    "./src/db/schema-org-tokens.ts",
    "./src/db/schema-invites.ts",
    "./src/db/schema-timings.ts",
  ],
  out: "./drizzle",
});
