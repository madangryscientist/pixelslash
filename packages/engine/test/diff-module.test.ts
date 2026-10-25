import { afterEach, describe, expect, test, vi } from "vitest";
import { PNG } from "pngjs";

const pair = (): [Buffer, Buffer] => {
  const png = PNG.sync.write(new PNG({ width: 4, height: 3 }));
  return [png, Buffer.from(png)];
};

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.doUnmock("#diff-module");
  vi.resetModules();
});

describe("the diff has no fallback: a module that will not run fails by name (PS-210)", () => {
  test("diff.wasm that will not load names its path", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (original) => ({
      ...(await original<typeof import("node:fs")>()),
      readFileSync: () => {
        throw new Error("ENOENT: no such file");
      },
    }));
    const { measurePngs } = await import("../src/diff.ts");
    expect(() => measurePngs(...pair())).toThrow(
      /^diff\.wasm will not load from \/.*\/wasm\/diff\.wasm: ENOENT: no such file$/,
    );
  });

  test("a module that is not the diff says so", async () => {
    vi.resetModules();
    // The smallest valid module: the magic and the version, no exports.
    const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    vi.doMock("#diff-module", () => ({ diffModule: () => new WebAssembly.Module(empty) }));
    const { measurePngs } = await import("../src/diff.ts");
    expect(() => measurePngs(...pair())).toThrow("diff.wasm does not export the diff");
  });

  test("the CLI's diff resolves #diff-module to the Bun loader", async () => {
    const { diffModule } = await import("#diff-module");
    expect(diffModule()).toBeInstanceOf(WebAssembly.Module);
    expect(import.meta.resolve("#diff-module")).toMatch(/\/src\/diff-module\.bun\.ts$/);
  });
});
