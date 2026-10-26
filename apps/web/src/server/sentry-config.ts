/** The Worker's Sentry vars (PS-227): `wrangler.jsonc` `vars`, overlaid on a self-host by `.dev.vars`. */
export type SentryEnv = {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SENTRY_ENVIRONMENT?: string;
};

/** What the server and the browser both need to report as the same deploy. */
export type SentryConfig = { dsn: string; release: string; environment: string };

/**
 * The reporting config, or null when no DSN is set: the one gate for the whole feature. Without a
 * DSN the SDK is never initialised on the server, the browser is never sent the config, and no
 * request leaves for an error sink.
 */
export function sentryConfigOf(env: SentryEnv): SentryConfig | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    dsn,
    release: env.SENTRY_RELEASE?.trim() || "unknown",
    environment: env.SENTRY_ENVIRONMENT?.trim() || "dev",
  };
}
