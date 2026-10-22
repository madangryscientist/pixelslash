/**
 * A stand-in for the upload API (`/api/v1`) of a project that diffs in CI: it opens builds, names
 * the last upload of each shot as its baseline, serves that PNG, and keeps every shot's meta. The
 * CLI then measures each shot against its baseline with the engine, as it does against a server.
 */
type Stored = { id: string; png: Buffer; ignore: unknown; fingerprint: unknown };
type Key = Record<string, unknown>;
export type ShotMeta = Key & {
  name: string;
  ignore: unknown[];
  ci?: { results: { status: string; diffResult: { ignoredPixels: number } }[] };
};

/** A shot's key: the identity the baselines request and the upload's meta both carry. */
const keyOf = (k: Key) => [k["name"], k["browser"], k["viewport"], k["theme"]].join(" / ");

const isKey = (v: unknown): v is Key => typeof v === "object" && v !== null;
const isMeta = (v: unknown): v is ShotMeta =>
  isKey(v) && typeof v["name"] === "string" && Array.isArray(v["ignore"]);
const pick = (s: Stored | undefined) =>
  s
    ? { id: s.id, image_url: `/images/${s.id}.png`, fingerprint: s.fingerprint, ignore: s.ignore }
    : null;
const notFound = () => Response.json({ error: "not found" }, { status: 404 });

export function uploadStub() {
  const shots = new Map<string, Stored>();
  const metas: ShotMeta[] = [];
  let builds = 0;

  async function baselines(req: Request): Promise<Response> {
    const body: unknown = await req.json();
    const keys = isKey(body) && Array.isArray(body["keys"]) ? body["keys"].filter(isKey) : [];
    return Response.json({
      api_version: 1,
      diff_location: "ci",
      baselines: keys.map((key) => ({
        key,
        baseline: pick(shots.get(keyOf(key))),
        carry: null,
        accepted: null,
      })),
    });
  }

  function image(path: string): Response {
    const id = path.slice("/images/".length, -".png".length);
    const s = [...shots.values()].find((x) => x.id === id);
    return s ? new Response(new Uint8Array(s.png)) : notFound();
  }

  async function upload(req: Request): Promise<Response> {
    const form = await req.formData();
    const raw = form.get("meta");
    const meta: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    const file = form.get("file");
    if (!isMeta(meta) || !(file instanceof Blob))
      return Response.json({ error: "bad shot" }, { status: 400 });
    metas.push(meta);
    const id = `s${metas.length}`;
    shots.set(keyOf(meta), {
      id,
      png: Buffer.from(await file.arrayBuffer()),
      ignore: meta.ignore,
      fingerprint: meta["fingerprint"],
    });
    return Response.json({ id });
  }

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const route = `${req.method} ${path.replace(/^\/api\/v1\/builds\/[^/]+/, "/build")}`;
      if (route === "POST /api/v1/builds")
        return Response.json({ id: `b${++builds}`, diffLocation: "ci" }, { status: 201 });
      if (route === "POST /build/baselines") return baselines(req);
      if (route === "PUT /build/snapshots") return upload(req);
      if (route === "POST /build/finalize") return Response.json({ status: "completed" });
      if (req.method === "GET" && path.startsWith("/images/")) return image(path);
      return notFound();
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, metas, stop: () => server.stop(true) };
}
