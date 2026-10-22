import type { ProjectFlake } from "#/db/flakes";
import { signedImagePath } from "#/storage/signed";
import { imageSigningSecret } from "./env";

/*
 * Only server fn handlers call this. It lives apart from `flakes.ts`, which components import:
 * an exported helper that reads the env keeps `cloudflare:workers` in the client bundle.
 */

/**
 * A flake with its evidence's images signed (ob 1724): run 1 is the shot itself, the rest are the
 * re-captures stored beside it.
 */
export const signFlakeOrNull = (orgId: string, flake: ProjectFlake | null) =>
  flake ? signedFlake(orgId, flake) : null;

export async function signedFlake(orgId: string, flake: ProjectFlake) {
  const secret = imageSigningSecret();
  const sign = (key: string) => signedImagePath(`orgs/${orgId}/${key}`, secret);
  return {
    ...flake,
    evidence: await Promise.all(
      flake.evidence.map(async (e) => ({
        ...e,
        images: [
          { run: 1, url: await sign(e.imageKey) },
          ...(await Promise.all(
            e.captures.map(async (c) => ({ run: c.run, url: await sign(c.key) })),
          )),
        ],
      })),
    ),
  };
}

export type FlakeView = Awaited<ReturnType<typeof signedFlake>>;
