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
