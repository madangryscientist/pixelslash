import type { SentryConfig } from "#/server/sentry-config";

type SentryReact = typeof import("@sentry/react");

/** Set once reporting has been started; stays null in a deployment with no DSN. */
let loaded: Promise<SentryReact | null> | null = null;

/**
 * Start reporting the review app's browser errors (PS-227), with the release and environment the
 * server was given, so one deploy reports as one release. The SDK is imported here and nowhere
 * else, so it is a chunk of its own that a page with no DSN never fetches. No tracing, no session
 * replay, no breadcrumbs, and the same `scrubEvent` as the server and the CLI: no cookie, body,
 * token or image data leaves with an error. Safe to call twice; the second call changes nothing.
 */
export function startBrowserSentry(config: SentryConfig | null): void {
  if (!config || loaded) return;
  loaded = Promise.all([import("@sentry/react"), import("@pixelslash/engine/sentry-scrub")])
    .then(([Sentry, { scrubEvent }]) => {
      Sentry.init({
        dsn: config.dsn,
        release: config.release,
        environment: config.environment,
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
        },
        tracesSampleRate: 0,
        maxBreadcrumbs: 0,
        beforeSend: scrubEvent,
      });
      return Sentry;
    })
    // A failed chunk load is not worth a second error: the page works without a reporter.
    .catch(() => null);
}

/** Report an error a route's error component caught; a no-op until (and unless) reporting started. */
export function reportBrowserError(error: unknown): void {
  void loaded?.then((Sentry) => Sentry?.captureException(error));
}
