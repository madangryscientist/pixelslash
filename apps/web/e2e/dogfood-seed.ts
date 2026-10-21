/** The fixed rows the organizations-page dogfood shoots (ob 1707): ids, names and times never change.
 * Seeded through `wrangler d1 execute`, so it is plain INSERTs against the migrated schema. */
import { createHash } from "node:crypto";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 12);

type Shot = { diff: "changed" | "new" | "unchanged" | null; review?: "accepted" };
type Build = {
  id: string;
  branch: string;
  pr: number | null;
  daysAgo: number;
  status: string;
  shots: [number, Shot["diff"], Shot["review"]?][];
};
type Project = { id: string; name: string; builds: Build[] };
type Org = {
  id: string;
  name: string;
  projects: Project[];
  members: { login: string; name: string | null; daysAgo: number }[];
  invites: string[];
};

/** `count` shots with the same diff status and review state. */
const shots = (count: number, diff: Shot["diff"], review?: "accepted"): Build["shots"] =>
  Array.from({ length: count }, () => [0, diff, review]);

const ORGS: Org[] = [
  {
    id: "org-hackcove",
    name: "hackcove",
    members: [
      { login: "e2e-octocat", name: "E2E Octocat", daysAgo: 90 },
      { login: "ada-lovelace", name: "Ada Lovelace", daysAgo: 60 },
      { login: "grace-hopper", name: null, daysAgo: 12 },
    ],
    invites: ["linus-t", "margaret-h"],
    projects: [
      {
        id: "proj-web",
        name: "web",
        builds: [
          {
            id: "b-web-1",
            branch: "main",
            pr: null,
            daysAgo: 5,
            status: "passed",
            shots: shots(12, "unchanged"),
          },
          {
            id: "b-web-2",
            branch: "feat/billing-page",
            pr: 42,
            daysAgo: 0,
            status: "changes",
            shots: [
              ...shots(5, "changed"),
              ...shots(2, "new"),
              ...shots(1, null),
              ...shots(1, "changed", "accepted"),
              ...shots(3, "unchanged"),
            ],
          },
        ],
      },
      {
        id: "proj-docs",
        name: "docs",
        builds: [
          {
            id: "b-docs-1",
            branch: "main",
            pr: null,
            daysAgo: 3,
            status: "passed",
            shots: shots(8, "unchanged"),
          },
        ],
      },
      {
        id: "proj-ui-kit",
        name: "ui-kit",
        builds: [
          {
            id: "b-kit-1",
            branch: "fix/focus-ring",
            pr: 17,
            daysAgo: 9,
            status: "passed",
            shots: [...shots(3, "changed", "accepted"), ...shots(20, "unchanged")],
          },
        ],
      },
      { id: "proj-legacy", name: "legacy-admin", builds: [] },
    ],
  },
  {
    id: "org-pixel-labs",
    name: "Pixel Labs",
    members: [{ login: "e2e-octocat", name: "E2E Octocat", daysAgo: 30 }],
    invites: [],
    projects: [
      {
        id: "proj-site",
        name: "site",
        builds: [
          {
            id: "b-site-1",
            branch: "redesign",
            pr: 8,
            daysAgo: 1,
            status: "changes",
            shots: [...shots(3, "changed"), ...shots(6, "unchanged")],
          },
        ],
      },
    ],
  },
  {
    id: "org-fresh",
    name: "Zed Studio",
    members: [{ login: "e2e-octocat", name: "E2E Octocat", daysAgo: 2 }],
    invites: [],
    projects: [],
  },
];

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const VIEWER = "(SELECT id FROM users WHERE login = 'e2e-octocat')";

/** The INSERTs for every org above. Ids and times are fixed; the viewer is whoever the stub signed in. */
export function seedSql(): string {
  const out: string[] = [];
  for (const org of ORGS) {
    out.push(
      `INSERT INTO orgs (id, name, created_at) VALUES (${q(org.id)}, ${q(org.name)}, ${T0 - 100 * DAY});`,
    );
    for (const m of org.members) {
      const user = m.login === "e2e-octocat" ? VIEWER : q(`user-${m.login}`);
      if (m.login !== "e2e-octocat") {
        out.push(
          `INSERT OR IGNORE INTO users (id, github_id, login, name, created_at) VALUES (${user}, ${1000 + out.length}, ${q(m.login)}, ${m.name ? q(m.name) : "NULL"}, ${T0 - 200 * DAY});`,
        );
      }
      out.push(
        `INSERT INTO members (org_id, user_id, created_at) VALUES (${q(org.id)}, ${user}, ${T0 - m.daysAgo * DAY});`,
      );
    }
    for (const login of org.invites) {
      out.push(
        `INSERT INTO invites (id, org_id, github_login, invited_by, created_at) VALUES (${q(`inv-${login}`)}, ${q(org.id)}, ${q(login)}, ${VIEWER}, ${T0 - DAY});`,
      );
    }
    for (const p of org.projects) {
      out.push(
        `INSERT INTO projects (id, org_id, name, created_at) VALUES (${q(p.id)}, ${q(org.id)}, ${q(p.name)}, ${T0 - 80 * DAY});`,
      );
      for (const b of p.builds) out.push(...buildSql(p, b));
    }
  }
  return out.join("\n");
}

function buildSql(p: Project, b: Build): string[] {
  const rows = [
    `INSERT INTO builds (id, project_id, commit_sha, branch, pr_number, status, created_at) VALUES (${q(b.id)}, ${q(p.id)}, ${q(createHash("sha1").update(b.id).digest("hex"))}, ${q(b.branch)}, ${b.pr ?? "NULL"}, ${q(b.status)}, ${T0 - b.daysAgo * DAY});`,
  ];
  for (const [i, [, diff, review]] of b.shots.entries()) {
    rows.push(
      `INSERT INTO snapshots (id, build_id, name, platform, browser, viewport, theme, env_fingerprint, image_key, diff_status, review_state) VALUES (${q(`${b.id}-s${i}`)}, ${q(b.id)}, ${q(`shot-${i}`)}, 'linux', 'chromium', '1280x720', 'light', 'seed', ${q(`seed/${b.id}-${i}.png`)}, ${diff ? q(diff) : "NULL"}, ${q(review ?? "pending")});`,
    );
  }
  return rows;
}
