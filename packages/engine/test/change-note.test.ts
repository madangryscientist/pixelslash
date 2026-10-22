import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, test } from "vitest";
import { changeNoter, parseChangeNote } from "../src/change-note.ts";
import { diffPngs, summarizeDiff } from "../src/diff.ts";
import { uploadSnapshots } from "../src/upload.ts";
import { visionStub } from "./dev-feature-fixtures.ts";
import { type Call, fakeServer, metaOf } from "./fake-server.ts";
import { FP, cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);

/** A 16x16 white PNG, with a red square at (4, 4) when `marked`. */
function png(marked = false): Buffer {
  const img = new PNG({ width: 16, height: 16 });
  img.data.fill(255);
  if (marked)
    for (let y = 4; y < 12; y++)
      for (let x = 4; x < 12; x++) img.data.set([220, 30, 30, 255], (y * 16 + x) << 2);
  return PNG.sync.write(img);
}

const notes = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith("pixelslash-note-"));

describe("parseChangeNote", () => {
  test("takes the CHANGE line's text", () => {
    expect(parseChangeNote("thinking...\nCHANGE: The button is now red.\n")).toBe(
      "The button is now red.",
    );
    expect(parseChangeNote("change the header moved down")).toBe("the header moved down");
  });

  test("NONE, an empty CHANGE or no CHANGE line gives no sentence", () => {
    expect(parseChangeNote("NONE")).toBeNull();
    expect(parseChangeNote("CHANGE ")).toBeNull();
    expect(parseChangeNote("The button is red.")).toBeNull();
  });
});

describe("changeNoter", () => {
  test("shows the judge main then the branch, with the boxes, and removes main's temp file", async () => {
    const { shown, deps } = visionStub("CHANGE The square turned red.");
    const prompts: string[] = [];
    const noter = changeNoter({
      ...deps,
      spawn: (cmd, opts) => {
        prompts.push(cmd.join(" "));
        return deps.spawn(cmd, opts);
      },
    });
    const diff = summarizeDiff(diffPngs(png(), png(true), { threshold: 0.1 }));
    const before = await notes();
    const note = await noter?.({ file: "/shots/home.png", main: png(), diff });
    expect(note).toBe("The square turned red.");
    expect(shown[0]?.[0]).toMatch(/pixelslash-note-.*\/main\.png$/);
    expect(shown[0]?.[1]).toBe("/shots/home.png");
    expect(prompts[0]).toContain("- x 4, y 4, 8x8 px");
    expect(prompts[0]).toContain("no score");
    expect(await notes()).toEqual(before);
  });
});

/** A server-diff project holding one white baseline for every shot. */
function server() {
  return fakeServer((c: Call) => {
    if (c.method === "POST" && c.url.endsWith("/api/v1/builds"))
      return Response.json({ id: "b1", diffLocation: "server" }, { status: 201 });
    if (c.url.endsWith("/baselines")) {
      const keys: unknown = typeof c.body === "object" && c.body && Reflect.get(c.body, "keys");
      if (!Array.isArray(keys)) throw new Error("no keys sent");
      const baseline = {
        id: "s0",
        image_url: "/images/orgs/o/s0.png",
        fingerprint: FP,
        ignore: [],
      };
      return Response.json({
        api_version: 1,
        diff_location: "server",
        baselines: keys.map((key) => ({ key, baseline, carry: null, accepted: null })),
      });
    }
    if (c.method === "GET" && c.url.includes("/images/")) return new Response(png());
    return undefined;
  });
}

/** Upload `home` (changed) and `about` (unchanged) with `describe`; the PUTs' metas by name. */
async function uploadWith(noter: (shot: { main: Buffer; file: string }) => Promise<string>) {
  const { dir: cwd } = await repo(1, 1);
  const dir = await snapshotDir([entry("home"), entry("about")]);
  await Bun.write(join(dir, "home/desktop.png"), png(true));
  await Bun.write(join(dir, "about/desktop.png"), png());
  const fake = server();
  const warnings: string[] = [];
  await uploadSnapshots(
    { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd) },
    { fetch: fake.fetch, describe: noter, warn: (m) => warnings.push(m) },
  );
  const metas = fake.calls
    .filter((c) => c.method === "PUT")
    .map((c) => metaOf(c.body) as ReturnType<typeof metaOf> & { changeNote?: string });
  const byName = Object.fromEntries(metas.map((m) => [m.name, m]));
  return { byName, warnings };
}

describe("uploadSnapshots with a judge (ob 1745)", () => {
  test("a changed shot carries the sentence; an unchanged one carries none, nor any result", async () => {
    const seen: { main: Buffer; file: string }[] = [];
    const { byName } = await uploadWith(async (shot) => {
      seen.push(shot);
      return "The square turned red";
    });
    expect(byName.home?.changeNote).toBe("The square turned red");
    expect(byName.about).not.toHaveProperty("changeNote");
    expect(byName.home).not.toHaveProperty("ci");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.file).toMatch(/home\/desktop\.png$/);
    expect(seen[0]?.main.equals(png())).toBe(true);
  });

  test("a judge that fails is said, and the shot goes up without a sentence", async () => {
    const { byName, warnings } = await uploadWith(async () => {
      throw new Error("model crashed");
    });
    expect(byName.home).not.toHaveProperty("changeNote");
    expect(warnings).toContain("judge: home / chromium / 1280x720 / light: model crashed");
  });
});
