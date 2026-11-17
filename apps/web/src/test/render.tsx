import type { ReactNode } from "react";
import { cleanup, render as renderDom, type RenderResult } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import {
  type AnyRouter,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useLoaderData,
} from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";
import type { Db } from "#/db/db";
import { users } from "#/db/schema";
import type { User } from "#/db/users";

/**
 * The one render helper for DOM tests (a test file that uses it starts with
 * `// @vitest-environment happy-dom`): Testing Library over happy-dom, with the app's router around
 * the component at a memory history, and the server functions a route calls bound to a temp store.
 *
 * Binding a route's server functions takes three `vi.mock` calls in the test file, since only the
 * test file's own are hoisted above its imports:
 *
 * ```ts
 * vi.mock("#/server/env", () => import("#/test/render").then((m) => m.serverEnv));
 * vi.mock("#/server/session", () => import("#/test/render").then((m) => m.serverSession));
 * vi.mock("#/server/twin-fns", async (actual) => {
 *   const fns = await actual<typeof import("#/server/twin-fns")>();
 *   const { bindServerFn } = await import("#/test/render");
 *   return { ...fns, saveTwinProject: bindServerFn(fns.twinProjectInput, fns.saveTwin) };
 * });
 * ```
 *
 * then `await signInTo(await world())` seeds a fresh `testDb()` store and signs in as its user.
 * The fn module mock is needed because a `createServerFn` outside the Start compiler neither runs
 * its validator nor returns its handler's result: each server function a test binds is split into
 * its validator and a plain function of the store, the viewer and the input, which it wraps.
 */

// Testing Library unmounts after each test only where `afterEach` is a global; Vitest's is not.
afterEach(cleanup);

export { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";

/** The store and the signed-in user the bound server functions run against; set by `signInTo`. */
const app: { db: Db | null; user: User | null } = { db: null, user: null };

afterEach(() => {
  app.db = null;
  app.user = null;
});

const store = (): Db => {
  if (!app.db) throw new Error("no store: call signInTo(seed) first");
  return app.db;
};

/**
 * Points the server functions at a seeded store, signed in as the seed's user (a seed is any
 * factory's result with `db` and `userId`, such as `world()`). Returns the seed.
 */
export async function signInTo<T extends { db: Db; userId: string }>(seed: T): Promise<T> {
  const [user] = await seed.db.select().from(users).where(eq(users.id, seed.userId));
  if (!user) throw new Error(`the seed has no user ${seed.userId}`);
  app.db = seed.db;
  app.user = user;
  return seed;
}

/** `#/server/env` in a DOM test: the store is the seeded one, and nothing else is bound. */
export const serverEnv = { database: store };

/** `#/server/session` in a DOM test: the viewer is the signed-in user, without a cookie. */
export const serverSession = {
  viewer: async (): Promise<User | null> => app.user,
  requireViewer: async (): Promise<User> => {
    if (!app.user) throw redirect({ to: "/" });
    return app.user;
  },
};

/**
 * A server function as the client calls it (`fn({ data })`), running its validator and then its
 * plain function against the seeded store as the signed-in user, in this process.
 */
export function bindServerFn<I, R>(
  input: (d: unknown) => I,
  run: (db: Db, user: User, data: I) => R,
) {
  return async ({ data }: { data: unknown }) => {
    const valid = input(data);
    return run(store(), await serverSession.requireViewer(), valid);
  };
}

export type Rendered = RenderResult & {
  router: AnyRouter;
  user: ReturnType<typeof userEvent.setup>;
};

/**
 * A route to render: its path pattern, the loader (calling server functions, bound or not) and the
 * component, which gets what the loader returned as `data`. It sits under the root at `path`, as
 * the app's route tree places it, and a `router.invalidate()` runs the loader again.
 */
export type RouteUnderTest<L> = {
  path: string;
  loader: (ctx: { params: Record<string, string> }) => Promise<L>;
  component: (props: { data: L }) => ReactNode;
};

/**
 * Renders `ui`, or a route at `url`, inside the router at a memory history, and waits for the
 * router's first load. `user` types and clicks as a person does (Testing Library's user-event).
 */
export async function render<L>(
  what: ReactNode | RouteUnderTest<L>,
  { url = "/" }: { url?: string } = {},
): Promise<Rendered> {
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    ...(isRoute(what) ? routed(what) : { path: "/", component: () => what }),
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [isRoute(what) ? url : "/"] }),
  });
  await router.load();
  const user = userEvent.setup();
  const result = renderDom(<RouterProvider router={router} />);
  return { ...result, router, user };
}

/**
 * The route's options. The component reads what the loader last returned from here rather than
 * through `useLoaderData`, whose type is the app's registered route tree, not this one; the hook
 * is still called, so a new load renders the component again.
 */
function routed<L>(what: RouteUnderTest<L>) {
  let last: { data: L } | null = null;
  return {
    path: what.path,
    loader: async ({ params }: { params: Record<string, string> }) => {
      last = { data: await what.loader({ params }) };
      return last;
    },
    component: function Page(): ReactNode {
      useLoaderData({ strict: false });
      if (!last) throw new Error("the route rendered before its loader ran");
      const Component = what.component;
      return <Component data={last.data} />;
    },
  };
}

function isRoute<L>(what: ReactNode | RouteUnderTest<L>): what is RouteUnderTest<L> {
  return typeof what === "object" && what !== null && "component" in what && "path" in what;
}
