import { describe, expect, test } from "vitest";
import { dirname, join } from "node:path";

const transpiler = new Bun.Transpiler({ loader: "ts" });

/**
 * Every bare specifier the module graph from `entry` loads at startup: static imports only, following
 * relative paths and `@pixelslash/*`. A type-only import is erased and an `import()` waits for its
 * command, so neither is followed.
 */
async function staticDeps(entry: string): Promise<Set<string>> {
  const bare = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file; file = queue.pop()) {
    if (seen.has(file) || !file.endsWith(".ts")) continue;
    seen.add(file);
    // The transpiler rejects the bin's shebang; a JSON import (the engine's version) has no imports.
    const code = (await Bun.file(file).text()).replace(/^#!.*/, "");
    for (const { path, kind } of transpiler.scanImports(code)) {
      if (kind !== "import-statement") continue;
      if (path.startsWith(".") || path.startsWith("@pixelslash/")) {
        queue.push(Bun.resolveSync(path, dirname(file)));
      } else bare.add(path);
    }
  }
  return bare;
}

describe("the MCP server is loaded only by `pixelslash mcp` (ob 1767)", () => {
  test("the bin's static import graph does not reach the MCP SDK", async () => {
    const deps = [...(await staticDeps(join(import.meta.dirname, "..", "src", "index.ts")))];
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.filter((d) => d.startsWith("@modelcontextprotocol/"))).toEqual([]);
  });

  test("the scan does see the SDK where it is imported", async () => {
    const deps = await staticDeps(join(import.meta.dirname, "..", "src", "mcp.ts"));
    expect(deps).toContain("@modelcontextprotocol/sdk/server/index.js");
  });
});
