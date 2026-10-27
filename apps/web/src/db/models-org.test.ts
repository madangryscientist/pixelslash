import { Buffer } from "node:buffer";
import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { setup } from "#/api/test-support";
import {
  ModelSettingsError,
  clearOrgModel,
  clearProjectModel,
  listOrgModelViews,
  orgModelView,
  projectModelFor,
  projectModelSource,
  setOrgModel,
  setProjectModel,
} from "./models";
import { NotFoundError } from "./db";
import { orgModels } from "./schema";
import { TEST_MODEL_KEY_SECRET as SECRET } from "./test-db";
import { signInGithubUser } from "./users";

const settings = {
  baseUrl: "https://api.deepseek.com/",
  model: "deepseek-flash",
  apiKey: "sk-one",
  autoPassNoise: false,
  modelKeySecret: SECRET as string | undefined,
  // Every name resolves to a public address (TEST-NET-3): no lookup leaves the test.
  modelHosts: { allowPrivate: false, resolve: async () => ["203.0.113.10"] },
};

/** The org's model (ob 1789): shared by its projects, overridden by a project's own. */
describe("an org's model", () => {
  const orgSettings = {
    ...settings,
    baseUrl: "https://org.example/v1",
    model: "org-model",
    apiKey: "sk-org",
  };

  test("org only: a project without its own uses the org's, with the org's key", async () => {
    const { db, acme, other } = await setup();
    expect(await projectModelFor(db, acme.project.id, SECRET)).toBeNull();
    await setOrgModel(db, acme.user.id, acme.org.id, orgSettings);
    expect(await projectModelFor(db, acme.project.id, SECRET)).toEqual({
      baseUrl: "https://org.example/v1",
      model: "org-model",
      apiKey: "sk-org",
      autoPassNoise: false,
    });
    // Another org's project is not touched.
    expect(await projectModelFor(db, other.project.id, SECRET)).toBeNull();
    const source = await projectModelSource(db, acme.user.id, acme.project.id);
    expect(source).toMatchObject({ source: "org", model: { model: "org-model" } });
  });

  test("project only: no org model changes nothing", async () => {
    const { db, acme } = await setup();
    await setProjectModel(db, acme.user.id, acme.project.id, settings);
    expect(await projectModelFor(db, acme.project.id, SECRET)).toMatchObject({ apiKey: "sk-one" });
    expect(await projectModelSource(db, acme.user.id, acme.project.id)).toMatchObject({
      source: "project",
      org: null,
    });
  });

  test("both: the project's own wins; cleared, it falls back to the org's", async () => {
    const { db, acme } = await setup();
    await setOrgModel(db, acme.user.id, acme.org.id, orgSettings);
    await setProjectModel(db, acme.user.id, acme.project.id, settings);
    expect(await projectModelFor(db, acme.project.id, SECRET)).toMatchObject({
      model: "deepseek-flash",
      apiKey: "sk-one",
    });
    expect(await projectModelSource(db, acme.user.id, acme.project.id)).toMatchObject({
      source: "project",
      org: { model: "org-model" },
    });
    await clearProjectModel(db, acme.user.id, acme.project.id);
    expect(await projectModelFor(db, acme.project.id, SECRET)).toMatchObject({
      model: "org-model",
      apiKey: "sk-org",
    });
    await clearOrgModel(db, acme.user.id, acme.org.id);
    expect(await projectModelFor(db, acme.project.id, SECRET)).toBeNull();
  });

  test("a project whose own key cannot be read does not borrow the org's endpoint", async () => {
    const { db, acme } = await setup();
    await setOrgModel(db, acme.user.id, acme.org.id, orgSettings);
    await setProjectModel(db, acme.user.id, acme.project.id, settings);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const wrong = Buffer.alloc(32, 3).toString("base64");
      expect(await projectModelFor(db, acme.project.id, wrong)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("the key is sealed at rest and never reaches a page", async () => {
    const { db, acme } = await setup();
    await setOrgModel(db, acme.user.id, acme.org.id, orgSettings);
    const [row] = await db.select().from(orgModels).where(eq(orgModels.orgId, acme.org.id));
    expect(row?.apiKey).toMatch(/^v1:[\w+/=]+:[\w+/=]+$/);
    expect(JSON.stringify(row)).not.toContain("sk-org");
    const views = [
      await orgModelView(db, acme.user.id, acme.org.id),
      await listOrgModelViews(db, acme.user.id),
      await projectModelSource(db, acme.user.id, acme.project.id),
    ];
    expect(JSON.stringify(views)).not.toContain("sk-org");
    expect(views[0]).toEqual({
      baseUrl: "https://org.example/v1",
      model: "org-model",
      autoPassNoise: false,
      keySet: true,
    });
  });

  test("same rules as a project's: a kept key, a new URL needs it again, a save needs a secret", async () => {
    const { db, acme } = await setup();
    await setOrgModel(db, acme.user.id, acme.org.id, orgSettings);
    await setOrgModel(db, acme.user.id, acme.org.id, { ...orgSettings, apiKey: "", model: "m2" });
    expect(await projectModelFor(db, acme.project.id, SECRET)).toMatchObject({
      model: "m2",
      apiKey: "sk-org",
    });
    await expect(
      setOrgModel(db, acme.user.id, acme.org.id, {
        ...orgSettings,
        apiKey: "",
        baseUrl: "https://elsewhere.example",
      }),
    ).rejects.toThrow(/needs its key again/);
    await expect(
      setOrgModel(db, acme.user.id, acme.org.id, { ...orgSettings, modelKeySecret: undefined }),
    ).rejects.toThrow("MODEL_KEY_SECRET is not set");
    await expect(
      setOrgModel(db, acme.user.id, acme.org.id, { ...orgSettings, baseUrl: "file:///x" }),
    ).rejects.toBeInstanceOf(ModelSettingsError);
  });

  test("a non-member can neither see, set nor clear it", async () => {
    const { db, acme } = await setup();
    await setOrgModel(db, acme.user.id, acme.org.id, orgSettings);
    const stranger = await signInGithubUser(db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    await expect(orgModelView(db, stranger.id, acme.org.id)).rejects.toThrow(NotFoundError);
    await expect(setOrgModel(db, stranger.id, acme.org.id, orgSettings)).rejects.toThrow(
      NotFoundError,
    );
    await expect(clearOrgModel(db, stranger.id, acme.org.id)).rejects.toThrow(NotFoundError);
    expect(await listOrgModelViews(db, stranger.id)).toEqual([]);
    expect(await projectModelFor(db, acme.project.id, SECRET)).not.toBeNull();
  });
});
