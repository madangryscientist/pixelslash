/**
 * The self-host's D1 is a SQLite file, and another process can hold its write lock for a moment:
 * a deploy's `wrangler d1 migrations apply`, or `d1 execute`. SQLite then answers SQLITE_BUSY at
 * once instead of waiting, and a diff run that meets it would end its build `errored` on the first
 * busy (PS-228: a deploy during an upload errored the build). A busy statement did not run, so it
 * is safe to run again. Cloudflare's D1 does not lock like this, and the wrapper costs it nothing.
 */

/** Waits between tries, ms: five tries in all, and a lock held longer than this is a real failure. */
const BUSY_BACKOFF_MS = [25, 50, 100, 200];

const isBusy = (e: unknown): boolean => /SQLITE_BUSY|database is locked/i.test(String(e));

async function whileBusy<T>(run: () => Promise<T>): Promise<T> {
  for (const wait of BUSY_BACKOFF_MS) {
    try {
      return await run();
    } catch (e) {
      if (!isBusy(e)) throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return run();
}

const RETRIED = new Set<string | symbol>(["run", "all", "raw", "first"]);

/**
 * The binding with every statement tried again while the database is locked. Wrap it where the
 * `Db` is made, so every query, the diff and finalize path included, rides out a short lock. Only
 * single statements are retried: nothing here uses `batch` or `exec`, and replaying a multi-statement
 * `exec` after a busy partway through would run its first statements twice.
 */
export function retryBusy(d1: D1Database): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        const member = Reflect.get(target, prop, target);
        if (typeof member !== "function") return member;
        if (RETRIED.has(prop))
          return (...args: unknown[]) => whileBusy(() => member.apply(target, args));
        return member.bind(target);
      },
    });
  return new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query));
      const member = Reflect.get(target, prop, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
