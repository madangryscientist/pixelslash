import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { parseConfig } from "../src/config.ts";
import type { FeatureSource } from "../src/dev-refs.ts";
import { devController } from "../src/dev-session.ts";
import type { DevStore } from "../src/dev-store.ts";
import type { ProcLike, SpawnProc } from "../src/judge.ts";
import { fakeSession, tmpDir } from "./dev-fixtures.ts";

/** Shared by the feature tests (ob 1741): a config base, a solid PNG, a vision stub, a session. */

export const base = {
  baseUrl: "http://127.0.0.1:9",
  routes: ["/"],
  variants: [
    { name: "small", viewport: { width: 16, height: 16 } },
    { name: "wide", viewport: { width: 32, height: 16 }, theme: "dark" },
  ],
};

export function solid(width: number, height: number): Buffer {
  const img = new PNG({ width, height });
  img.data.fill(200);
  return PNG.sync.write(img);
}

/** A vision model that answers `answer` to everything, with the images it was shown. */
export function visionStub(answer: string) {
  const shown: string[][] = [];
  const spawn: SpawnProc = (cmd) => {
    shown.push(cmd.filter((a) => a.endsWith(".png")));
    const proc: ProcLike = {
      stdout: new Response(answer).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      exitCode: 0,
      signalCode: null,
    };
    return proc;
  };
  return { shown, deps: { spawn, which: () => "/bin/mlx" } };
}

/** A session with one 16×16 shot of `small`, and a feature with a spec and a ref of that size. */
export async function iterationWithRef(store: DevStore, refWidth: number, refHeight = 20) {
  const { session } = fakeSession(0);
  const dir = await tmpDir();
  const refFile = join(dir, "ref.png");
  await writeFile(refFile, solid(refWidth, refHeight));
  await writeFile(join(dir, "spec.md"), "The block is blue.");
  const variants = parseConfig({ ...base, variants: [base.variants[0]] }).variants;
  const def = { spec: join(dir, "spec.md"), refs: [{ kind: "png" as const, path: refFile }] };
  const src: FeatureSource = {
    def,
    store,
    variants,
    dpr: 1,
    figma: { token: undefined, fetch: globalThis.fetch },
  };
  return { session, src };
}

export function controller(
  store: DevStore,
  session: ReturnType<typeof fakeSession>["session"],
  extra: object,
) {
  return devController({
    store,
    session,
    target: "index",
    maxBytes: 1e9,
    main: undefined,
    noMain: "",
    againstMain: false,
    judge: undefined,
    feature: undefined,
    refreshRefs: false,
    onRun: () => {},
    onJudge: () => {},
    onExplain: () => {},
    onRefs: () => {},
    onError: () => {},
    ...extra,
  });
}
