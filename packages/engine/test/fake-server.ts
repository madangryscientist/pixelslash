import { createHash } from "node:crypto";

/**
 * A stand-in for the PixelSlash API: records every request, answers 200 (or what `failOn` says).
 * It also holds the PNGs it is sent (PS-424): `/known` names the ones it holds, and a shot sent by
 * hash for an image it does not hold is a 409 `image_unknown`, as the server's.
 */
export type Call = {
  method: string;
  url: string;
  auth: string | null;
  userAgent: string | null;
  body: unknown;
};

/** The hashes a `/known` call asked about. */
export function askedOf(call: Call | undefined): string[] {
  const body = call?.body;
  const asked = typeof body === "object" && body !== null && "sha256" in body ? body.sha256 : [];
  return Array.isArray(asked) ? asked.filter((h) => typeof h === "string") : [];
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The server's answer to a PUT: it keeps a PNG it is sent, and refuses a hash it does not hold. */
async function put(body: FormData, held: Set<string>): Promise<Response | undefined> {
  const file = body.get("file");
  if (file instanceof File) {
    held.add(sha256Hex(await file.bytes()));
    return undefined;
  }
  const { sha256 } = metaOf(body);
  if (sha256 && !held.has(sha256))
    return Response.json(
      {
        error: "no image with that sha256 is held by this project: send the PNG",
        code: "image_unknown",
      },
      { status: 409 },
    );
  return undefined;
}

/** What the stand-in answers once `failOn` has let a call through. */
async function answer(call: Call, held: Set<string>): Promise<Response> {
  if (call.method === "POST" && call.url.endsWith("/builds")) return Response.json({ id: "b1" });
  if (call.method === "POST" && call.url.endsWith("/known"))
    return Response.json({ known: askedOf(call).filter((h) => held.has(h)) });
  if (call.method === "PUT" && call.body instanceof FormData) {
    const refusal = await put(call.body, held);
    if (refusal) return refusal;
  }
  return Response.json({ id: "x" });
}

export function fakeServer(failOn?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const held = new Set<string>();
  const fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body;
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      auth: headers.get("authorization"),
      userAgent: headers.get("user-agent"),
      body: typeof body === "string" ? JSON.parse(body) : body,
    };
    calls.push(call);
    return failOn?.(call) ?? (await answer(call, held));
  };
  return { calls, fetch };
}

export function metaOf(body: unknown): {
  name: string;
  sha256?: string;
  ignore?: unknown;
  ci?: { engineVersion: string; results: unknown[] };
} {
  const meta = body instanceof FormData ? body.get("meta") : null;
  if (typeof meta !== "string") throw new Error("request has no meta field");
  return JSON.parse(meta);
}
