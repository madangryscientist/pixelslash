import * as Sentry from "@sentry/cloudflare";
import { scrubEvent } from "@pixelslash/engine/sentry-scrub";
import { type SentryEnv, sentryConfigOf } from "./sentry-config";

/**
 * The SDK's options for a request. No tracing, no breadcrumbs, no PII, and `scrubEvent` on every
 * event: a body, a cookie, a token or a shot never rides along (invariant 4).
 */
function sentryOptions(env: SentryEnv): Sentry.CloudflareOptions {
  const config = sentryConfigOf(env);
  return {
    dsn: config?.dsn,
    release: config?.release,
    environment: config?.environment,
    // Off at the SDK, as well as scrubbed after it: no user, cookies, headers, bodies or query strings.
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
  };
}

type Handler = Required<Pick<ExportedHandler<Env>, "fetch">> &
  Pick<ExportedHandler<Env>, "queue" | "scheduled">;

/**
 * `handler` with Sentry's request, queue and scheduled instrumentation, used only for a request whose env has
 * a DSN. `withSentry` calls `init` per request even with no DSN, so the gate is here: a deployment
 * without one runs the original handler untouched. `withSentry` mutates what it is given, so it
 * gets a copy.
 */
export function withOptionalSentry(handler: Handler): Handler {
  const instrumented = Sentry.withSentry(sentryOptions, { ...handler });
  const { queue, scheduled } = handler;
  return {
    fetch: (request, env, ctx) => {
      const live = sentryConfigOf(env) ? instrumented : handler;
      return live.fetch ? live.fetch(request, env, ctx) : handler.fetch(request, env, ctx);
    },
    ...(queue && {
      queue: (batch, env, ctx) => {
        const live = sentryConfigOf(env) ? instrumented : handler;
        return live.queue ? live.queue(batch, env, ctx) : queue(batch, env, ctx);
      },
    }),
    ...(scheduled && {
      scheduled: (controller, env, ctx) => {
        const live = sentryConfigOf(env) ? instrumented : handler;
        return live.scheduled
          ? live.scheduled(controller, env, ctx)
          : scheduled(controller, env, ctx);
      },
    }),
  };
}

/**
 * Report an error the framework or a handler caught, so the Worker's own `try`/`catch` does not
 * hide it from Sentry. A no-op when the request has no client (no DSN), and never throws: a failed
 * report must not turn into a failed request.
 */
export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  try {
    Sentry.captureException(error, { tags });
  } catch {
    // Dropped on purpose; see above.
  }
}
