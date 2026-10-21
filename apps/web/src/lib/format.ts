const FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/**
 * One rendering on the server and in the browser: the default locale and timezone differ between
 * the Worker and the laptop, and a mismatched string is a hydration error, not a nicety.
 */
export function formatDateTime(value: Date): string {
  return `${FORMAT.format(value)} UTC`;
}

const NUMBER = new Intl.NumberFormat("en-US");

/** The same grouping in the Worker and the browser. */
export function formatNumber(value: number): string {
  return NUMBER.format(value);
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** `19 Oct`, in UTC for the same reason as `formatDateTime`. */
export function formatDay(value: Date): string {
  return DAY.format(value);
}

/**
 * How long ago, to one unit: `just now`, `5 min ago`, `2 h ago`, `yesterday`, `3 d ago`, then the
 * day. `now` is passed in rather than read, so the server's render and the browser's agree.
 */
export function formatRelative(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} d ago`;
  return formatDay(then);
}
