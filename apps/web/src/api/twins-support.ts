import { expect } from "vitest";
import { createProject } from "#/db/orgs";
import { issueCiToken, issueUserToken } from "#/db/tokens";
import { signInGithubUser } from "#/db/users";
import { get } from "./test-read";
import { META, call, idOf, newBuild, setup, snapshotForm } from "./test-support";

/** Fixtures for the twin and stale tests on the API (PS-295, PS-297). */

export const PIXEL = {
  ...META,
  platform: "android",
  browser: "Pixel 8 API 35",
  viewport: "412x915",
  fingerprint: {
    image: "external",
    browser: "external",
    fonts: "unknown",
    platform: "android",
    device: "Pixel 8 API 35",
    scale: "2.625",
  },
};
export const WEB = { ...META, name: "Button/primary", theme: "dark" };
export const ANDROID = { ...PIXEL, name: "Button/primary", theme: "dark" };

export type Deps = Parameters<typeof call>[0];

export type ApiTwin = Record<string, unknown>;
export type ApiTwinEntry = {
  name: string;
  platform: string;
  twins: ApiTwin[];
  [key: string]: unknown;
};
export type ApiTwins = {
  twin_project: { id: string; name: string } | null;
  linked: ApiTwinEntry[];
  unlinked: ApiTwinEntry[];
};

/** A build read, with the `twins` section the shared reply type does not name (it is optional). */
export async function readBuild(deps: Deps, id: string, token: string) {
  const res = await get(deps, `/api/v1/builds/${id}`, token);
  expect(res.status).toBe(200);
  const build: { twins?: ApiTwins } = JSON.parse(JSON.stringify(res.body.build));
  return build;
}

/** The `twins` section of a build that has one. */
export async function readTwins(deps: Deps, id: string, token: string): Promise<ApiTwins> {
  const { twins } = await readBuild(deps, id, token);
  if (!twins) throw new Error("the build carries no twins section");
  return twins;
}

export const jsonOf = async (res: Response): Promise<{ project: Record<string, unknown> }> =>
  await res.json();

/** A finalised build on `token`'s project holding `shots`. */
export async function upload(deps: Deps, token: string, shots: object[], extra: object = {}) {
  const id = await idOf(await call(deps, "POST /api/v1/builds", token, newBuild(extra)));
  for (const meta of shots) {
    const res = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, token, snapshotForm(meta));
    expect(res.status).toBe(200);
  }
  const done = await call(
    deps,
    `POST /api/v1/builds/${id}/finalize`,
    token,
    JSON.stringify({ snapshots: shots.length }),
  );
  expect(done.status).toBe(200);
  return id;
}

/** Ada owns Acme (projects `web` and `native`) and Other; Eve belongs to neither. */
export async function world() {
  const base = await setup();
  const { db, acme } = base;
  const native = await createProject(db, acme.user.id, acme.org.id, "native");
  const nativeCi = await issueCiToken(db, acme.user.id, native.id, "ci");
  const ada = await issueUserToken(db, acme.user.id, "laptop", null);
  const eve = await signInGithubUser(db, {
    githubId: 2,
    login: "eve",
    name: null,
    avatarUrl: null,
  });
  const eveToken = await issueUserToken(db, eve.id, "laptop", null);
  return { ...base, native, nativeCi: nativeCi.token, ada: ada.token, eve: eveToken.token };
}

export const putTwin = (deps: Deps, projectId: string, token: string | null, body: object) =>
  call(deps, `PUT /api/v1/projects/${projectId}/twin`, token, JSON.stringify(body));
