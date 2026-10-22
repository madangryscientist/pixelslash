import { join } from "node:path";
import { expect, test } from "vitest";
import { ENDPOINTS } from "./handler";

/** The `METHOD /path` in the first cell of each row of the README's "API" endpoint table. */
async function documented(): Promise<string[]> {
  const readme = await Bun.file(join(import.meta.dirname, "../../../../README.md")).text();
  const section = readme.split(/^## API$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^\| `((?:GET|POST|PUT|PATCH|DELETE) \/api\/[^`]+)` \|/gm)].map(
    (m) => m[1] ?? "",
  );
}

test("the README's API section lists every endpoint the router has, and no other (ob 1729)", async () => {
  const listed = await documented();
  expect(listed.length).toBeGreaterThan(0);
  expect(new Set(listed).size).toBe(listed.length);
  expect(listed.toSorted()).toEqual(ENDPOINTS.map((e) => `${e.method} ${e.path}`).toSorted());
});
