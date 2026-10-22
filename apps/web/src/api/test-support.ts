import { createOrg, createProject } from "#/db/orgs";
import { testDb } from "#/db/test-db";
import { issueCiToken } from "#/db/tokens";
import { signInGithubUser } from "#/db/users";
import type { BlobStore } from "#/storage/blobs";
import { type ApiDeps, handleApi } from "./handler";

export const SHA = "a".repeat(40);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
export const META = {
  name: "pricing",
  platform: "linux",
  browser: "chromium",
  viewport: "1280x720",
  theme: "light",
  tags: ["web"],
  diff: { threshold: 0.2, minChangedPixels: 50, mergeDistance: 40, minRegionArea: 9, maxShift: 1 },
  ignore: [{ x: 10, y: 20, width: 300, height: 200 }],
  fingerprint: { image: "version:0", browser: "chromium 148", fonts: "sha256:f" },
};

export function memoryStore(failPuts = false) {
  const data = new Map<string, ArrayBuffer>();
  const store: BlobStore = {
    put: async (key, body) => {
      if (failPuts) throw new Error("r2 down");
      if (body instanceof ArrayBuffer) data.set(key, body);
    },
    get: async (key) => {
      const held = data.get(key);
      return held ? new Blob([held]).stream() : null;
    },
    delete: async (key) => void data.delete(key),
  };
  return { store, data };
}

export async function setup() {
  const db = testDb();
  const user = await signInGithubUser(db, {
    githubId: 1,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const tokenFor = async (orgName: string) => {
    const org = await createOrg(db, user.id, orgName);
    const project = await createProject(db, user.id, org.id, "web");
    const { id, token } = await issueCiToken(db, user.id, project.id, "ci");
    return { org, project, tokenId: id, token, user };
  };
  const acme = await tokenFor("Acme");
  const other = await tokenFor("Other");
  const blobs = memoryStore();
  const deps: ApiDeps = { db, store: blobs.store, imageSecret: () => "test-image-secret" };
  return { db, deps, blobs, acme, other };
}

/** `request` is "METHOD /path". */
export const call = (deps: ApiDeps, request: string, token: string | null, body?: BodyInit) => {
  const [method = "GET", path = "/"] = request.split(" ");
  return handleApi(
    new Request(`http://app.test${path}`, {
      method,
      body: body ?? null,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    deps,
  );
};

export const newBuild = (extra: object = {}) =>
  JSON.stringify({ commitSha: SHA, branch: "feat/x", mergeBaseSha: "b".repeat(40), ...extra });

export function snapshotForm(meta: object = META, bytes: Uint8Array<ArrayBuffer> = PNG) {
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  form.set("file", new File([bytes.slice()], "shot.png", { type: "image/png" }));
  return form;
}

export async function idOf(res: Response): Promise<string> {
  const body: unknown = await res.json();
  if (typeof body === "object" && body && "id" in body && typeof body.id === "string")
    return body.id;
  throw new Error("response has no id");
}

export async function openBuild(deps: ApiDeps, token: string) {
  return idOf(await call(deps, `POST /api/v1/builds`, token, newBuild()));
}
