import { join } from "node:path";
import { solidPng, tmp } from "./support.ts";

/** A dir of PNGs as a screenshot tool leaves them: loose, nested, with a stray file. */
export async function pngDir(): Promise<string> {
  const dir = await tmp();
  await Bun.write(join(dir, "home.png"), solidPng(40, 40, [100, 100, 100, 255]));
  await Bun.write(join(dir, "billing/invoice.PNG"), solidPng(40, 60, [200, 200, 200, 255]));
  await Bun.write(join(dir, "notes.txt"), "not a shot");
  return dir;
}

/** An upload API that keeps each snapshot's `meta` part, as the server reads it. */
export function metaApi() {
  const metas: Record<string, unknown>[] = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    const meta = init?.method === "PUT" && init.body instanceof FormData && init.body.get("meta");
    if (typeof meta === "string") metas.push(JSON.parse(meta));
    return Response.json({ id: "build-1", status: "passed" });
  };
  return { metas, fetch };
}
