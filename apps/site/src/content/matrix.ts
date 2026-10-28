import data from "../../../../docs/capabilities/data.json";

/*
 * The comparison, from docs/capabilities/data.json, scored as docs/capabilities/build.py scores
 * it: a row is behind when our value is worse than the best competitor's. Nothing here is curated.
 */

export type Value = "y" | "p" | "n" | "?";
/** A competitor's cell: its value and, where it is not a yes, why and the page it was read from. */
export type Cell = { v: Value; note: string; link: string };
export type Tool = { key: string; name: string; src: string };
export type Row = {
  group: string;
  key: string;
  label: string;
  ours: { v: Value; note: string };
  theirs: Record<string, Cell>;
  plan: string;
  gap: string;
  behind: boolean;
};

const SCORE: Record<Value, number> = { y: 2, p: 1, n: 0, "?": 0 };

export const VALUE_LABEL: Record<Value, string> = {
  y: "Yes",
  p: "Partly",
  n: "No",
  "?": "Not in docs",
};

function value(raw: string | undefined, where: string): Value {
  if (raw === "y" || raw === "p" || raw === "n" || raw === "?") return raw;
  throw new Error(`data.json: ${where} has value ${String(raw)}`);
}

export const TOOLS: Tool[] = data.tools
  .filter((tool) => tool.key !== "ps")
  .map((tool) => ({ key: tool.key, name: tool.name, src: "src" in tool ? tool.src : "" }));

const NOTES: Record<string, string> = data.notes;
const LINKS: Record<string, string> = data.links;

type RawRow = (typeof data.rows)[number];

function toRow(raw: RawRow): Row {
  const rawTheirs: Record<string, string> = raw.t;
  const theirs: Record<string, Cell> = {};
  for (const tool of TOOLS) {
    const id = `${tool.key}:${raw.k}`;
    theirs[tool.key] = {
      v: value(rawTheirs[tool.key], id),
      note: NOTES[id] ?? "",
      link: LINKS[id] ?? "",
    };
  }
  const ours = { v: value(raw.ps.v, `ps:${raw.k}`), note: raw.ps.note };
  const best = Math.max(...Object.values(theirs).map((theirCell) => SCORE[theirCell.v]));
  const extra: { plan?: string; gap?: string } = raw;
  return {
    group: raw.g,
    key: raw.k,
    label: raw.label,
    ours,
    theirs,
    plan: extra.plan ?? "",
    gap: extra.gap ?? "",
    behind: SCORE[ours.v] < best,
  };
}

export const ROWS: Row[] = data.rows.map(toRow);

export const SUMMARY = {
  rows: ROWS.length,
  behind: ROWS.filter((row) => row.behind).length,
  level: ROWS.filter((row) => !row.behind).length,
  updated: data.updated,
  audited: data.audited,
  oursCommit: data.ours_commit,
};

/** data.json's method sentence with its placeholders filled, as build.py fills them. */
export const METHOD = data.method
  .replace("{commit}", `${data.ours_commit} (audited ${data.audited})`)
  .replace("{date}", data.updated);

/** The rows grouped under their heading, in data.json's order. */
export function groups(rows: Row[] = ROWS): { group: string; rows: Row[] }[] {
  const out: { group: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last?.group === row.group) last.rows.push(row);
    else out.push({ group: row.group, rows: [row] });
  }
  return out;
}
