import { textOf } from "./render-routed";

/** The text of the element with this `data-testid` in rendered markup, or null when there is none. */
export function byTestId(html: string, id: string): string | null {
  const open = new RegExp(`<(\\w+)[^>]*data-testid="${id}"[^>]*>`).exec(html);
  if (!open) return null;
  const tag = open[1];
  const rest = html.slice(open.index + open[0].length);
  let depth = 1;
  for (const m of rest.matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, "g"))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return textOf(rest.slice(0, m.index));
  }
  return textOf(rest);
}
