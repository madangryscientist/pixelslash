import { setProjectModel } from "#/db/models";
import { TEST_MODEL_KEY_SECRET as SECRET } from "#/db/test-db";
import { FINGERPRINT, type Ctx, type Shot, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import type { ModelFetch } from "./model";

/** What the summary tests share (ob 1668): a stubbed OpenAI-compatible endpoint and a themed build. */

export const white = shot();
export const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const THEMES = ["default", "catppuccin-mocha", "nord"];
export const card = (png: typeof white): Shot[] =>
  THEMES.map((theme) => ({ name: `ui-card-hover@theme=${theme}`, png }));

export const KEY = "sk-test-not-a-real-key";
export const NOTE = "The card's top-left corner turned red.";

type Call = { body: string; images: boolean };

/**
 * An endpoint that explains every region with `NOTE` and answers the text-only summary call with
 * `summary(the prompt)`. `summaries` is every summary call's request body.
 */
export function stubModel(summary: (prompt: string) => string | Response = () => "Changed. [C1]") {
  const calls: Call[] = [];
  const modelFetch: ModelFetch = async (_input, init) => {
    const body = typeof init.body === "string" ? init.body : "";
    const images = body.includes("image_url");
    calls.push({ body, images });
    const answer = images ? `LABEL intended\nWHY ${NOTE}` : summary(promptOf(body));
    if (answer instanceof Response) return answer;
    return Response.json({ choices: [{ message: { content: answer } }] });
  };
  return {
    modelFetch,
    summaries: () => calls.filter((c) => !c.images).map((c) => c.body),
  };
}

/** The text part of a request: the summary call sends only that one. */
export const promptOf = (body: string): string => {
  const text: unknown = JSON.parse(/"text":("(?:[^"\\]|\\.)*")/.exec(body)?.[1] ?? '""');
  return typeof text === "string" ? text : "";
};

export async function withModel(ctx: Ctx) {
  await setProjectModel(ctx.db, ctx.userId, ctx.projectId, {
    baseUrl: "http://model.test/v1",
    model: "local-qwen",
    apiKey: KEY,
    autoPassNoise: false,
    modelKeySecret: SECRET,
    modelHosts: { allowPrivate: true },
  });
}

/** Main, then a branch where `card` changed in all three themes, `fresh` is new, `gone` removed. */
export async function themedBuild(ctx: Ctx, modelFetch: ModelFetch, extra: Shot[] = []) {
  await upload(
    ctx,
    {
      branch: "main",
      commit: sha(1),
      shots: [
        ...card(white),
        { name: "gone", png: white },
        ...extra.map((s) => ({ ...s, png: white, fingerprint: FINGERPRINT })),
      ],
    },
    { modelFetch: stubModel(() => "New. [N1]").modelFetch },
  );
  return upload(
    ctx,
    {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [...card(red), { name: "fresh", png: white }, ...extra],
    },
    { modelFetch },
  );
}
