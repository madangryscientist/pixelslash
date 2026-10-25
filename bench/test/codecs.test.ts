import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DECODERS, OVERLAYS, decodeWith, encodeWith } from "../src/impl/ts-codecs.ts";
import { DEFAULT_DECODER, parseArgs } from "../src/impl/ts-diff.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** Every PNG the bench decodes: both corpora and the DS fixtures. */
function corpusPngs(): string[] {
  return ["bench/corpus", "bench/corpus-holdout", "fixtures/ds"].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".png"))
      .map((f) => join(ROOT, dir, f)),
  );
}

function fingerprint(r: { data: Uint8Array; width: number; height: number }): string {
  return `${r.width}x${r.height} ${new Bun.CryptoHasher("sha256").update(r.data).digest("hex")}`;
}

describe("the TS decoders (PS-168)", () => {
  const files = corpusPngs();
  // pngjs's pixels per file, as a size and a hash: the whole corpus decoded is over a gigabyte.
  const baseline = new Map<string, string>();
  async function want(file: string, bytes: Buffer): Promise<string> {
    const known = baseline.get(file);
    if (known) return known;
    const print = fingerprint(await decodeWith("pngjs", bytes));
    baseline.set(file, print);
    return print;
  }

  test("the corpus is there", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  // pngjs is what the production engine decodes with; a candidate that differs on one byte of one
  // file can never ship, so each is held to it on every file.
  for (const name of DECODERS.filter((d) => d !== "pngjs")) {
    test(`${name} gives pngjs's RGBA on every corpus PNG`, async () => {
      for (const file of files) {
        const bytes = readFileSync(file);
        expect(fingerprint(await decodeWith(name, bytes)), `${name}: ${file}`).toBe(
          await want(file, bytes),
        );
      }
    }, 120_000);
  }
});

describe("the overlay encoders (PS-168)", () => {
  const overlay = { data: Buffer.alloc(16 * 8 * 4, 0x7f), width: 16, height: 8 };

  for (const name of OVERLAYS.filter((o) => o !== "none")) {
    test(`${name} writes a PNG that decodes back to the overlay`, async () => {
      const png = await encodeWith(name, overlay);
      const back = await decodeWith("pngjs", png);
      expect(Buffer.compare(back.data, overlay.data)).toBe(0);
    });
  }

  test("none writes nothing", async () => {
    expect((await encodeWith("none", overlay)).length).toBe(0);
  });
});

describe("ts-diff's switches (PS-168)", () => {
  const operands = ["diff", "b.png", "h.png", "--json"];
  test("its own flags go before diff, the runner's --decode after the operands", () => {
    expect(
      parseArgs([
        "--decoder",
        "upng",
        "--overlay",
        "pngjs-l1",
        ...operands,
        "--decode",
        "parallel",
      ]),
    ).toEqual({
      basePath: "b.png",
      headPath: "h.png",
      parallel: true,
      decoder: "upng",
      overlay: "pngjs-l1",
    });
    expect(parseArgs(operands)).toMatchObject({
      parallel: false,
      decoder: DEFAULT_DECODER,
      overlay: "none",
    });
  });

  test("an unknown value, a repeated switch or a stray operand is a usage error", () => {
    expect(parseArgs(["--decoder", "nope", ...operands])).toBeNull();
    expect(parseArgs(["--decode", "parallel", ...operands, "--decode", "parallel"])).toBeNull();
    expect(parseArgs([...operands, "extra"])).toBeNull();
    expect(parseArgs([...operands, "--decoder"])).toBeNull();
  });
});
