/** A stand-in for the PixelSlash API: records every request, answers 200 (or what `failOn` says). */
export type Call = { method: string; url: string; auth: string | null; body: unknown };

export function fakeServer(failOn?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body;
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof body === "string" ? JSON.parse(body) : body,
    };
    calls.push(call);
    const refused = failOn?.(call);
    if (refused) return refused;
    if (call.method === "POST" && url.endsWith("/builds")) return Response.json({ id: "b1" });
    return Response.json({ id: "x" });
  };
  return { calls, fetch };
}

export function metaOf(body: unknown): { name: string; ignore?: unknown } {
  const meta = body instanceof FormData ? body.get("meta") : null;
  if (typeof meta !== "string") throw new Error("request has no meta field");
  return JSON.parse(meta);
}
