import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";
import { describe, expect, test } from "vitest";
import { githubStubRefusal } from "./stub-guard";

/** `env.production` in `wrangler.jsonc` (PS-277): app.pixelslash.dev, and nothing else's config. */

const CONFIG = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const read = (env?: string) => unstable_readConfig({ config: CONFIG, env });

const SECRETS = [
  "IMAGE_SIGNING_SECRET",
  "MODEL_KEY_SECRET",
  "SENTRY_DSN",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
];

describe("env.production", () => {
  const prod = read("production");

  test("targets the real D1, the bucket and the queue, on the custom domain only", () => {
    expect(prod.name).toBe("pixelslash-web-production");
    expect(prod.d1_databases[0]?.database_id).toBe("d01057df-95e1-45ef-a54c-e2fd78c4e1cf");
    expect(prod.r2_buckets[0]?.bucket_name).toBe("pixelslash-blobs");
    expect(prod.queues.producers?.[0]?.queue).toBe("pixelslash-explain");
    expect(prod.routes).toEqual([{ pattern: "app.pixelslash.dev", custom_domain: true }]);
  });

  test("sets the production vars, and no var shadows a secret", () => {
    expect(prod.vars["PIXELSLASH_PUBLIC_URL"]).toBe("https://app.pixelslash.dev");
    expect(prod.vars["SENTRY_ENVIRONMENT"]).toBe("production");
    expect(prod.vars["DEFAULT_DIFF_LOCATION"]).toBe("ci");
    expect(prod.vars["PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS"]).toBe("");
    for (const name of SECRETS) expect(prod.vars).not.toHaveProperty(name);
  });

  test("passes the production build's stub guard", () => {
    const vars = Object.fromEntries(Object.entries(prod.vars).map(([k, v]) => [k, String(v)]));
    expect(githubStubRefusal("production", vars)).toBeNull();
  });

  test("leaves the unnamed config, which dev and the LAN build read, as it was", () => {
    const top = read();
    expect(top.d1_databases[0]?.database_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(top.name).toBe("pixelslash-web");
    expect(top.routes).toBeUndefined();
    expect(top.vars["PIXELSLASH_PUBLIC_URL"]).toBe("");
    expect(read("e2e").routes).toBeUndefined();
  });
});
