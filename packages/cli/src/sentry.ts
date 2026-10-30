import { CLIENT_VERSION } from "@pixelslash/engine";
import { scrubEvent } from "@pixelslash/engine/sentry-scrub";

/** The CLI reports errors to Sentry only when this names a DSN (PS-227); unset, it does nothing. */
const SENTRY_DSN_VAR = "PIXELSLASH_SENTRY_DSN";
/** Names the environment the report is filed under; `cli` when unset. */
const SENTRY_ENVIRONMENT_VAR = "PIXELSLASH_SENTRY_ENVIRONMENT";

/** Waiting for the envelope to leave is bounded: a dead ingest must not hold up the exit code. */
const FLUSH_MS = 2000;

/** What the report is told about the run; the error itself carries the rest. */
export type SentryContext = {
  /** `crash` is a bug (exit 7); `upload` is an `UPLOAD FAILED` run. Never "new violations". */
  kind: "crash" | "upload";
  command: string;
  stage: string | undefined;
};

/**
 * Sends `error` to the DSN in `env`, once, and returns when it has left or `FLUSH_MS` has passed.
 * Without a DSN nothing is imported, initialised or sent: the SDK is a dynamic import so a run
 * without one never loads it. The default integrations are off, so it patches nothing and
 * installs no process handlers: this one explicit report is all it does. A report that fails is
 * dropped, since telling the user about a failed report must never change a run's exit code.
 */
export async function reportToSentry(
  env: Record<string, string | undefined>,
  error: unknown,
  context: SentryContext,
): Promise<void> {
  const dsn = env[SENTRY_DSN_VAR];
  if (!dsn) return;
  try {
    const Sentry = await import("@sentry/bun");
    Sentry.initWithoutDefaultIntegrations({
      dsn,
      release: `pixelslash@${CLIENT_VERSION}`,
      environment: env[SENTRY_ENVIRONMENT_VAR] || "cli",
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      tracesSampleRate: 0,
      maxBreadcrumbs: 0,
      // The default is the machine's hostname.
      serverName: "pixelslash-cli",
      beforeSend: scrubEvent,
    });
    Sentry.captureException(error, {
      tags: { kind: context.kind, command: context.command, stage: context.stage ?? "none" },
    });
    await Sentry.close(FLUSH_MS);
  } catch {
    // Dropped on purpose; see above.
  }
}
