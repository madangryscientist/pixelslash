import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Page, test as base, expect } from "@playwright/test";
import { sql } from "./d1";

export { SIGNED_OUT } from "./session";

/**
 * What every web e2e spec imports instead of `@playwright/test`: the signed-in session the `setup`
 * project saves, one `provision` that builds an org, its project and a CI token straight in the D1,
 * and one `open()` that every navigation goes through.
 */

/**
 * A full load, then the hydration marker on the `<Page>` frame: before it a click or key can be
 * lost. Returns the load's response, for a spec that reads its status. A route that renders no
 * `<Page>` (a JSON route, a signed-out redirect) passes `{ hydrated: false }`.
 */
export async function open(page: Page, path: string, { hydrated = true } = {}) {
  const response = await page.goto(path);
  if (hydrated) await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  return response;
}

type Provisioned = {
  orgId: string;
  orgName: string;
  projectId: string;
  projectName: string;
  token: string;
};

type ProvisionOptions = {
  /** The org name before its suffix; the spec's own literal. */
  org?: string;
  project?: string;
  /** Add the project (and its token) to that provision's org instead of making a new one. */
  into?: Provisioned;
  /** Name the org exactly `org`, with no suffix: for a run that shoots the page, on a fresh D1. */
  exact?: boolean;
};

export type Provision = (options?: ProvisionOptions) => Promise<Provisioned>;

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const VIEWER = "(SELECT id FROM users WHERE login = 'e2e-octocat')";

/** The token as `issueCiToken` (`src/db/tokens.ts`) makes it: `psci_`, then 32 random bytes in base64url. */
function ciToken() {
  const token = `psci_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    hash: createHash("sha256").update(token).digest("hex"),
    prefix: token.slice(0, 9),
  };
}

/**
 * The org (named `${org} ${suffix}`, the suffix unique per test and per repeat), the stub user as its
 * member, the project and a CI token, written to the D1 in one statement batch: what clicking through
 * the orgs page and the project settings made. Creating each by clicking is `orgs.spec.ts`.
 */
function provisionRows({ org = "Flake Co", project = "flaky", into, exact }: ProvisionOptions) {
  const made = into === undefined;
  const ids = {
    orgId: into?.orgId ?? randomUUID(),
    projectId: randomUUID(),
    tokenId: randomUUID(),
  };
  const orgName = into?.orgName ?? (exact ? org : `${org} ${randomUUID().slice(0, 8)}`);
  const { token, hash, prefix } = ciToken();
  const rows = [
    ...(made
      ? [
          `INSERT INTO orgs (id, name) VALUES (${q(ids.orgId)}, ${q(orgName)})`,
          `INSERT INTO members (org_id, user_id) VALUES (${q(ids.orgId)}, ${VIEWER})`,
        ]
      : []),
    // `newProject` (src/server/fns.ts) gives a new project the deployment's DEFAULT_DIFF_LOCATION,
    // which the e2e env leaves unset: `server`. The default branch is the column's, `main`.
    `INSERT INTO projects (id, org_id, name, diff_location) VALUES (${q(ids.projectId)}, ${q(ids.orgId)}, ${q(project)}, 'server')`,
    `INSERT INTO ci_tokens (id, project_id, name, token_hash, prefix, created_by) VALUES (${q(ids.tokenId)}, ${q(ids.projectId)}, 'ci', ${q(hash)}, ${q(prefix)}, ${VIEWER})`,
  ];
  sql(rows.join(";\n"));
  return { orgId: ids.orgId, orgName, projectId: ids.projectId, projectName: project, token };
}

export const test = base.extend<{ provision: Provision }>({
  // Playwright reads a fixture's needs from its first argument's pattern, which may not be empty; this
  // one needs none, so it names `baseURL`, an option that costs nothing to resolve.
  provision: async ({ baseURL: _baseURL }, use) => {
    await use(async (options = {}) => provisionRows(options));
  },
});

export { expect };
