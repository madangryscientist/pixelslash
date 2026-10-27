import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { setProjectModel } from "#/db/models";
import { TEST_MODEL_KEY_SECRET as SECRET } from "#/db/test-db";
import { type Ctx, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import type { ModelFetch } from "./model";

/** What the explain tests share (ob 1473, 1875): a stubbed OpenAI-compatible endpoint and builds. */

export const W = 200;
export const H = 100;
export const TOP_LEFT = { x: 10, y: 10, w: 16, h: 12 };
export const BOTTOM_RIGHT = { x: 150, y: 60, w: 20, h: 20 };
export const white = shot({ width: W, height: H });
export const twoChanges = shot({
  width: W,
  height: H,
  blocks: [
    { ...TOP_LEFT, rgb: RED },
    { ...BOTTOM_RIGHT, rgb: RED },
  ],
});

// OpenCode Go, so every call names its build as its session (ob 1794).
export const BASE_URL = "https://opencode.ai/inference/go/openai/v1";
export const KEY = "sk-test-not-a-real-key";

export type Sent = { url: string; auth: string | null; model: string; images: PNG[] };

/**
 * An OpenAI-compatible endpoint that records each region call and answers with `reply(call index)`.
 * The build's text-only summary call (ob 1668) is answered apart.
 */
export function stubModel(
  reply: (n: number) => string | Error | Response = () => "LABEL noise\nWHY Edges moved.",
) {
  const sent: Sent[] = [];
  const sessions: (string | null)[] = [];
  const modelFetch: ModelFetch = async (input, init) => {
    const body = typeof init.body === "string" ? init.body : "";
    sessions.push(new Headers(init.headers).get("x-opencode-session"));
    if (!body.includes("image_url")) {
      const ref = /\\n(\[[CNR]\d+\])/.exec(body)?.[1] ?? "";
      return Response.json({ choices: [{ message: { content: `Something moved. ${ref}` } }] });
    }
    const images = [...body.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map(([, b64]) =>
      PNG.sync.read(Buffer.from(b64 ?? "", "base64")),
    );
    sent.push({
      url: input,
      auth: new Headers(init.headers).get("authorization"),
      model: /"model":"([^"]+)"/.exec(body)?.[1] ?? "",
      images,
    });
    const answer = reply(sent.length - 1);
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return Response.json({ choices: [{ message: { role: "assistant", content: answer } }] });
  };
  return { sent, sessions, modelFetch };
}

export async function withModel(ctx: Ctx, autoPassNoise: boolean) {
  await setProjectModel(ctx.db, ctx.userId, ctx.projectId, {
    baseUrl: BASE_URL,
    model: "deepseek-flash",
    apiKey: KEY,
    autoPassNoise,
    modelKeySecret: SECRET,
    modelHosts: { allowPrivate: true },
  });
}

/** Main all white, then a branch build with two separate red blocks: two `change` regions. */
export async function branchBuild(ctx: Ctx, modelFetch: ModelFetch) {
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
  return upload(
    ctx,
    { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: twoChanges }] },
    { modelFetch },
  );
}

export const pixel = (img: PNG, x: number, y: number) => {
  const at = (y * img.width + x) * 4;
  return [img.data[at], img.data[at + 1], img.data[at + 2]];
};
