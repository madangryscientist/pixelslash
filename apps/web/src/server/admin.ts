import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { operatorHealth } from "#/db/admin-health";
import { isAdmin } from "#/lib/admin-access";
import { CODE_MIGRATIONS } from "#/lib/code-migrations";
import { adminLogins, database, databaseBytes, releaseSha } from "./env";
import { viewer } from "./session";

/* The operator's health page (PS-330). */

/**
 * Anyone not on `PIXELSLASH_ADMIN_LOGINS` gets the router's 404, the same as a path that does not
 * exist: signed out, signed in and not listed, and the variable unset all look alike.
 */
export const getOperatorHealth = createServerFn().handler(async () => {
  const user = await viewer();
  if (!isAdmin(user, adminLogins())) throw notFound();
  return operatorHealth(database(), {
    now: new Date(),
    releaseSha: releaseSha(),
    codeMigrations: CODE_MIGRATIONS,
    dbBytes: await databaseBytes(),
  });
});
