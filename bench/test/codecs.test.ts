import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { OVERLAYS, encodeWith } from "../src/impl/ts-codecs.ts";
import { parseArgs } from "../src/impl/ts-diff.ts";

describe("the overlay encoders (PS-168)", () => {
  const overlay = { data: Buffer.alloc(16 * 8 * 4, 0x7f), width: 16, height: 8 };

  for (const name of OVERLAYS.filter((o) => o !== "none")) {
    test(`${name} writes a PNG that decodes back to the overlay`, async () => {
      const png = await encodeWith(name, overlay);
      const back = PNG.sync.read(png);
      expect(Buffer.compare(back.data, overlay.data)).toBe(0);
    });
  }

  test("none writes nothing", async () => {
    expect((await encodeWith("none", overlay)).length).toBe(0);
  });
});

describe("ts-diff's switches (PS-168, PS-210)", () => {
  const operands = ["diff", "b.png", "h.png", "--json"];
  test("its own flags go before diff, the runner's --decode after the operands", () => {
    expect(parseArgs(["--overlay", "pngjs-l1", ...operands, "--decode", "parallel"])).toEqual({
      basePath: "b.png",
      headPath: "h.png",
      overlay: "pngjs-l1",
    });
    expect(parseArgs(operands)).toMatchObject({ overlay: "none" });
  });

  test("an unknown value, a repeated switch or a stray operand is a usage error", () => {
    expect(parseArgs(["--overlay", "nope", ...operands])).toBeNull();
    expect(parseArgs(["--decode", "parallel", ...operands, "--decode", "parallel"])).toBeNull();
    expect(parseArgs([...operands, "extra"])).toBeNull();
    expect(parseArgs([...operands, "--overlay"])).toBeNull();
    // PS-210: the one engine is diff.wasm, and its decode is its own, so a decoder has nothing to pick.
    expect(parseArgs(["--engine", "wasm", ...operands])).toMatchObject({ overlay: "none" });
    expect(parseArgs(["--decoder", "pngjs", ...operands])).toBeNull();
    expect(parseArgs(["--engine", "ts", ...operands])).toBeNull();
  });
});
