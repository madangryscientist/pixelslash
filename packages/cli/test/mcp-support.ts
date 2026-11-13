import { SERVER, fakeApi } from "./remote-support.ts";

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** The fake API, plus the read endpoints the MCP tools add and a signed image route. */
export function api(server = SERVER) {
  const base = fakeApi();
  Object.assign(base.replies, {
    "/api/v1/snapshots/s1": {
      api_version: 1,
      snapshot: {
        id: "s1",
        name: "home",
        group: "changed",
        images: {
          head: `${server}/images/head`,
          baseline: `${server}/images/base`,
          diff: null,
        },
      },
    },
    "/api/v1/snapshots/s3": {
      api_version: 1,
      snapshot: { id: "s3", images: {}, metrics_url: `${server}/images/orgs/o/m.metrics.json` },
    },
    "/api/v1/snapshots/s2": {
      api_version: 1,
      snapshot: { id: "s2", images: { head: "https://elsewhere.example/x.png" } },
    },
    "/api/v1/projects/p1/flakes": { api_version: 1, flakes: [{ id: "f1" }], next_cursor: null },
    "/api/v1/projects/p1/detection-flags": {
      api_version: 1,
      detection_flags: [{ id: "d1", kind: "missed" }],
      next_cursor: null,
    },
  });
  const images: string[] = [];
  const fetch = async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    if (!url.pathname.startsWith("/images/")) return base.fetch(raw, init);
    images.push(url.pathname);
    if (url.pathname.endsWith(".metrics.json"))
      return Response.json({
        version: "1.0",
        root: "a",
        parts: { a: { box: { x: 0, y: 0, w: 1, h: 2 } } },
      });
    return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
  };
  return { ...base, fetch, images };
}
