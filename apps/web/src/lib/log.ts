/**
 * The Worker's log: the one place the server writes to the console. A line is for an operator
 * reading `wrangler tail`; it never carries a secret.
 */
export function warn(message: string): void {
  console.warn(message);
}
