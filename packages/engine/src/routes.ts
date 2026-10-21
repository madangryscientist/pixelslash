import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { UsageError } from "./errors.ts";

export function routeSlug(path: string): string {
  const trimmed = path.replace(/\/+$/, "") || "/";
  if (trimmed === "/") return "index";
  // Anything outside the name's alphabet (`/`, and a query string's `?` `&` `=`) becomes `-`.
  return (
    trimmed
      .replace(/^\//, "")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "index"
  );
}

/** An absolute `http:` or `https:` URL. */
export function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);
}

export function joinOrigin(origin: string, path: string): string {
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  const rel = path.startsWith("/") ? path.slice(1) : path;
  return new URL(rel, base).href;
}

export async function loadRoutes(file: string): Promise<string[]> {
  if (!existsSync(file)) throw new UsageError(`routes file not found: ${file}`);
  const text = await readFile(file, "utf8");
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    if (!raw.startsWith("/")) throw new UsageError(`route must start with /: ${raw}`);
    const path = raw === "/" ? "/" : raw.replace(/\/+$/, "") || "/";
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  if (paths.length === 0) throw new UsageError("routes file is empty");
  return paths;
}
