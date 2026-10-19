import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { UsageError } from "./errors.ts";

export function routeSlug(path: string): string {
  const trimmed = path.replace(/\/+$/, "") || "/";
  if (trimmed === "/") return "index";
  return trimmed.replace(/^\//, "").replace(/\//g, "-");
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
