import { describe, expect, test } from "vitest";
import { setup } from "#/api/test-support";
import {
  ModelSettingsError,
  clearProjectModel,
  projectModelFor,
  projectModelView,
  setProjectModel,
} from "./models";
import { NotFoundError } from "./db";
import { signInGithubUser } from "./users";

/** A project's model settings (ob 1473): the key is write-only and tied to its base URL. */

const settings = {
  baseUrl: "https://api.deepseek.com/",
  model: "deepseek-flash",
  apiKey: "sk-one",
  autoPassNoise: false,
};

describe("project model settings", () => {
  test("a page sees whether a key is set, never the key", async () => {
    const { db, acme } = await setup();
    await setProjectModel(db, acme.user.id, acme.project.id, settings);
    const view = await projectModelView(db, acme.user.id, acme.project.id);
    expect(view).toEqual({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      autoPassNoise: false,
      keySet: true,
    });
    expect(JSON.stringify(view)).not.toContain("sk-one");
  });

  test("a save with no key keeps the stored one; a new base URL needs it again", async () => {
    const { db, acme } = await setup();
    await setProjectModel(db, acme.user.id, acme.project.id, settings);
    await setProjectModel(db, acme.user.id, acme.project.id, {
      ...settings,
      apiKey: "",
      autoPassNoise: true,
    });
    expect(await projectModelFor(db, acme.project.id)).toMatchObject({
      apiKey: "sk-one",
      autoPassNoise: true,
    });
    await expect(
      setProjectModel(db, acme.user.id, acme.project.id, {
        ...settings,
        baseUrl: "http://localhost:11434/v1",
        apiKey: "",
      }),
    ).rejects.toThrow(/needs its key again/);
  });

  test("a first save needs a key, and a base URL must be http(s) with no credentials", async () => {
    const { db, acme } = await setup();
    const save = (extra: object) =>
      setProjectModel(db, acme.user.id, acme.project.id, { ...settings, ...extra });
    await expect(save({ apiKey: "" })).rejects.toBeInstanceOf(ModelSettingsError);
    await expect(save({ baseUrl: "file:///etc/passwd" })).rejects.toBeInstanceOf(
      ModelSettingsError,
    );
    await expect(save({ baseUrl: "https://u:p@api.deepseek.com" })).rejects.toBeInstanceOf(
      ModelSettingsError,
    );
    await expect(save({ model: " " })).rejects.toBeInstanceOf(ModelSettingsError);
    expect(await projectModelFor(db, acme.project.id)).toBeNull();
  });

  test("a non-member can neither see nor set it, and removing it removes the key", async () => {
    const { db, acme } = await setup();
    await setProjectModel(db, acme.user.id, acme.project.id, settings);
    const stranger = await signInGithubUser(db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    await expect(projectModelView(db, stranger.id, acme.project.id)).rejects.toThrow(NotFoundError);
    await expect(setProjectModel(db, stranger.id, acme.project.id, settings)).rejects.toThrow(
      NotFoundError,
    );
    await clearProjectModel(db, acme.user.id, acme.project.id);
    expect(await projectModelFor(db, acme.project.id)).toBeNull();
  });
});
