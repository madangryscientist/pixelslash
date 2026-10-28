import { expect, test } from "vitest";
import { bindingsFrom, missingConfig } from "./start";

const kept = (name: string) => `kept-${name}`;

test("the environment wins over the build's vars and the self-host defaults", () => {
  const bindings = bindingsFrom(
    {
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      DEFAULT_DIFF_LOCATION: "client",
      APP_NAME: "",
      PATH: "/usr/bin",
    },
    ["GITHUB_CLIENT_ID", "DEFAULT_DIFF_LOCATION", "APP_NAME"],
    kept,
  );
  expect(bindings).toMatchObject({
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    DEFAULT_DIFF_LOCATION: "client",
    SENTRY_ENVIRONMENT: "self-host",
  });
  // An empty value is unset, and a name that is neither a var nor a secret is not a binding.
  expect(bindings).not.toHaveProperty("APP_NAME");
  expect(bindings).not.toHaveProperty("PATH");
});

test("the signing and sealing secrets come from the volume unless the environment sets them", () => {
  const generated = bindingsFrom({}, [], kept);
  expect(generated["IMAGE_SIGNING_SECRET"]).toBe("kept-IMAGE_SIGNING_SECRET");
  expect(generated["MODEL_KEY_SECRET"]).toBe("kept-MODEL_KEY_SECRET");
  expect(bindingsFrom({ IMAGE_SIGNING_SECRET: "env" }, [], kept)["IMAGE_SIGNING_SECRET"]).toBe(
    "env",
  );
});

test("refuses to start without the GitHub OAuth app", () => {
  expect(missingConfig({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" })).toBeNull();
  expect(missingConfig({ GITHUB_CLIENT_ID: "id" })).toMatch(/^GITHUB_CLIENT_SECRET must be set/);
  expect(missingConfig({})).toMatch(/^GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set/);
});
