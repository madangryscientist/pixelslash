// @vitest-environment happy-dom
import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { createOrg, createProject } from "#/db/orgs";
import { getProject } from "#/db/project-read";
import { projects } from "#/db/schema";
import { type World, world } from "#/db/twins-test-support";
import { useHydrated } from "#/lib/use-hydrated";
import { getTwinOptions } from "#/server/twin-fns";
import { render, screen, signInTo, within } from "#/test/render";
import { TwinSettings } from "./twin-settings";

vi.mock("#/server/env", () => import("#/test/render").then((m) => m.serverEnv));
vi.mock("#/server/session", () => import("#/test/render").then((m) => m.serverSession));
vi.mock("#/server/twin-fns", async (actual) => {
  const fns = await actual<typeof import("#/server/twin-fns")>();
  const { bindServerFn } = await import("#/test/render");
  return {
    ...fns,
    getTwinOptions: bindServerFn(fns.twinOptionsInput, fns.twinOptions),
    saveTwinProject: bindServerFn(fns.twinProjectInput, fns.saveTwin),
  };
});

type Loaded = { projectId: string; saved: string | null; options: { id: string; name: string }[] };

/** The card with the props the settings route gives it. */
function Settings({ data }: { data: Loaded }) {
  return (
    <TwinSettings
      projectId={data.projectId}
      saved={data.saved}
      options={data.options}
      hydrated={useHydrated()}
    />
  );
}

/**
 * The project settings' twin card (PS-295) with its server functions running against a seeded
 * store, signed in as the seed's user. The card is fed as the settings route feeds it: the saved
 * twin and the options (`getTwinOptions`) from the loader, which a save re-runs.
 */
async function openSettings(seed: World, projectId: string) {
  const rendered = await render(
    {
      path: "/projects/$projectId/settings",
      loader: async ({ params }) => {
        const data = { projectId: params.projectId ?? "" };
        const [project, options] = await Promise.all([
          getProject(seed.db, seed.userId, data.projectId),
          getTwinOptions({ data }),
        ]);
        return { projectId: project.id, saved: project.twinProjectId, options };
      },
      component: Settings,
    },
    { url: `/projects/${projectId}/settings` },
  );
  const card = within(screen.getByTestId("twin-project"));
  const select = () => card.getByRole("combobox", { name: "Twin project" });
  return { ...rendered, card, select };
}

const twinOf = async (seed: World, projectId: string) =>
  (await seed.db.select().from(projects).where(eq(projects.id, projectId)))[0]?.twinProjectId;

describe("the project settings' twin project", () => {
  test("a project alone in its org has nothing to link", async () => {
    const seed = await signInTo(await world());
    // `world()` makes two projects in Acme; the one project of a fresh org is alone.
    const solo = await createOrg(seed.db, seed.userId, "Solo");
    const only = await createProject(seed.db, seed.userId, solo.id, "only");
    const { card } = await openSettings(seed, only.id);
    expect(card.getByTestId("no-twin-options").textContent).toBe(
      "This org has no other project to link.",
    );
    expect(card.queryByRole("button", { name: "Save twin project" })).toBeNull();
  });

  test("picking a project and saving links it, and the page then holds the saved choice", async () => {
    const seed = await signInTo(await world());
    const { web, native } = seed;
    const { card, select, user } = await openSettings(seed, native);
    const save = card.getByRole("button", { name: "Save twin project" });
    expect(save).toHaveProperty("disabled", true);

    await user.selectOptions(select(), "web");
    expect(save).toHaveProperty("disabled", false);
    await user.click(save);

    expect(await twinOf(seed, native)).toBe(web);
    // The save re-ran the loader: the card now holds `web` as saved, so there is nothing to save.
    expect(await card.findByRole("button", { name: "Save twin project" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(select()).toHaveProperty("value", web);
  });

  test("choosing None and saving clears the link", async () => {
    const seed = await signInTo(await world());
    await seed.db
      .update(projects)
      .set({ twinProjectId: seed.web })
      .where(eq(projects.id, seed.native));
    const { card, select, user } = await openSettings(seed, seed.native);
    expect(select()).toHaveProperty("value", seed.web);

    await user.selectOptions(select(), "None");
    await user.click(card.getByRole("button", { name: "Save twin project" }));

    expect(await twinOf(seed, seed.native)).toBeNull();
    expect(await card.findByRole("button", { name: "Save twin project" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(select()).toHaveProperty("value", "");
  });

  test("a refused save says why in the alert, and links nothing", async () => {
    const seed = await signInTo(await world());
    const { card, select, user } = await openSettings(seed, seed.native);
    // The option on screen went to another org after the page loaded.
    const elsewhere = await createOrg(seed.db, seed.userId, "Elsewhere");
    await seed.db.update(projects).set({ orgId: elsewhere.id }).where(eq(projects.id, seed.web));

    await user.selectOptions(select(), "web");
    await user.click(card.getByRole("button", { name: "Save twin project" }));

    expect((await card.findByRole("alert")).textContent).toBe(
      "the twin must be another project of the same org",
    );
    expect(await twinOf(seed, seed.native)).toBeNull();
  });
});
