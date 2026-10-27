import { Buffer } from "node:buffer";
import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { setup } from "#/api/test-support";
import {
  ModelSettingsError,
  clearProjectModel,
  projectModelFor,
  projectModelView,
  setProjectModel,
} from "./models";
import { NotFoundError } from "./db";
import { projectModels } from "./schema";
import { TEST_MODEL_KEY_SECRET as SECRET } from "./test-db";
import { signInGithubUser } from "./users";

/** A project's model settings (ob 1473): the key is write-only and tied to its base URL. */

const settings = {
  baseUrl: "https://api.deepseek.com/",
  model: "deepseek-flash",
  apiKey: "sk-one",
  autoPassNoise: false,
  modelKeySecret: SECRET as string | undefined,
  // Every name resolves to a public address (TEST-NET-3): no lookup leaves the test.
  modelHosts: { allowPrivate: false, resolve: async () => ["203.0.113.10"] },
};

const rowOf = async (db: Awaited<ReturnType<typeof setup>>["db"], projectId: string) => {
  const [row] = await db.select().from(projectModels).where(eq(projectModels.projectId, projectId));
  return row;
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
    expect(await projectModelFor(db, acme.project.id, SECRET)).toMatchObject({
      apiKey: "sk-one",
      autoPassNoise: true,
    });
    await expect(
      setProjectModel(db, acme.user.id, acme.project.id, {
        ...settings,
        baseUrl: "https://elsewhere.example/v1",
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
    expect(await projectModelFor(db, acme.project.id, SECRET)).toBeNull();
  });

  test("a private host is refused at save (PS-250), named or resolved, unless the server allows it", async () => {
    const { db, acme } = await setup();
    const save = (extra: object) =>
      setProjectModel(db, acme.user.id, acme.project.id, { ...settings, ...extra });
    await expect(save({ baseUrl: "http://169.254.169.254/v1" })).rejects.toThrow(/link-local/);
    await expect(save({ baseUrl: "http://localhost:11434/v1" })).rejects.toThrow(/loopback/);
    const rebound = { allowPrivate: false, resolve: async () => ["10.0.0.7"] };
    await expect(
      save({ baseUrl: "https://model.example/v1", modelHosts: rebound }),
    ).rejects.toBeInstanceOf(ModelSettingsError);
    expect(await projectModelFor(db, acme.project.id, SECRET)).toBeNull();
    await save({ baseUrl: "http://localhost:11434/v1", modelHosts: { allowPrivate: true } });
    expect(await projectModelFor(db, acme.project.id, SECRET)).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
    });
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
    expect(await projectModelFor(db, acme.project.id, SECRET)).toBeNull();
  });
});

/** The key at rest (ob 1786): sealed under MODEL_KEY_SECRET, never plain text in the row. */
describe("a project's model key at rest", () => {
  const OTHER = Buffer.alloc(32, 9).toString("base64");

  test("the row never holds the key's plain text, and projectModelFor returns the key", async () => {
    const { db, acme } = await setup();
    await setProjectModel(db, acme.user.id, acme.project.id, settings);
    const row = await rowOf(db, acme.project.id);
    expect(row?.apiKey).toMatch(/^v1:[\w+/=]+:[\w+/=]+$/);
    expect(JSON.stringify(row)).not.toContain("sk-one");
    expect((await projectModelFor(db, acme.project.id, SECRET))?.apiKey).toBe("sk-one");
  });

  test("a plain-text row from before still reads, and is sealed on the next save", async () => {
    const { db, acme } = await setup();
    await db.insert(projectModels).values({
      projectId: acme.project.id,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      apiKey: "sk-old-plain",
    });
    expect((await projectModelFor(db, acme.project.id, SECRET))?.apiKey).toBe("sk-old-plain");
    expect((await projectModelFor(db, acme.project.id, undefined))?.apiKey).toBe("sk-old-plain");
    await setProjectModel(db, acme.user.id, acme.project.id, { ...settings, apiKey: "" });
    const row = await rowOf(db, acme.project.id);
    expect(row?.apiKey).toMatch(/^v1:/);
    expect(JSON.stringify(row)).not.toContain("sk-old-plain");
    expect((await projectModelFor(db, acme.project.id, SECRET))?.apiKey).toBe("sk-old-plain");
  });

  test("a save with no key leaves a sealed key as stored, without opening it", async () => {
    const { db, acme } = await setup();
    await setProjectModel(db, acme.user.id, acme.project.id, settings);
    const sealed = (await rowOf(db, acme.project.id))?.apiKey;
    const keep = { ...settings, apiKey: "", model: "other", modelKeySecret: OTHER };
    await setProjectModel(db, acme.user.id, acme.project.id, keep);
    expect(await rowOf(db, acme.project.id)).toMatchObject({ apiKey: sealed, model: "other" });
  });

  test("with no secret a save fails by name and stores nothing", async () => {
    const { db, acme } = await setup();
    await expect(
      setProjectModel(db, acme.user.id, acme.project.id, {
        ...settings,
        modelKeySecret: undefined,
      }),
    ).rejects.toThrow("MODEL_KEY_SECRET is not set");
    await expect(
      setProjectModel(db, acme.user.id, acme.project.id, {
        ...settings,
        modelKeySecret: "not base64 of 32 bytes",
      }),
    ).rejects.toThrow("MODEL_KEY_SECRET must be base64 of 32 bytes");
    expect(await rowOf(db, acme.project.id)).toBeUndefined();
  });

  test("a plain-text row is not re-saved without a secret, and stays plain text", async () => {
    const { db, acme } = await setup();
    await db.insert(projectModels).values({
      projectId: acme.project.id,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      apiKey: "sk-old-plain",
    });
    await expect(
      setProjectModel(db, acme.user.id, acme.project.id, {
        ...settings,
        apiKey: "",
        modelKeySecret: undefined,
      }),
    ).rejects.toThrow("MODEL_KEY_SECRET is not set");
    expect((await rowOf(db, acme.project.id))?.apiKey).toBe("sk-old-plain");
  });

  test("a sealed row without the secret, or under another, is no model, logged once, no key", async () => {
    const { db, acme } = await setup();
    await setProjectModel(db, acme.user.id, acme.project.id, settings);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await projectModelFor(db, acme.project.id, undefined)).toBeNull();
      expect(await projectModelFor(db, acme.project.id, undefined)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("MODEL_KEY_SECRET is not set");
      expect(await projectModelFor(db, acme.project.id, OTHER)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]?.[0])).toContain("cannot be decrypted");
      for (const [line] of warn.mock.calls) {
        const text = String(line);
        for (const secret of [SECRET, OTHER, "sk-one", (await rowOf(db, acme.project.id))?.apiKey])
          expect(text).not.toContain(secret ?? "");
      }
    } finally {
      warn.mockRestore();
    }
  });
});
