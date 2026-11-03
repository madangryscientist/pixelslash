import { createServerFn } from "@tanstack/react-start";
import { getProjectWithOrg } from "#/db/orgs";
import { buildView } from "#/db/review";
import { parityShotsOf } from "#/db/parity-columns";
import { signedImagePath } from "#/storage/signed";
import { blobStore, database, imageSigningSecret } from "./env";
import { field, or404 } from "./input";
import { buildParityView } from "./parity-view";
import { requireViewer } from "./session";

/**
 * The parity view of one snapshot key of a build (PS-298): web, android and ios side by side, the
 * metrics comparison and the similarity hint. A read; nothing it computes is stored.
 */
export const getParityPage = createServerFn()
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    buildId: field(d, "buildId"),
    name: field(d, "name"),
    theme: field(d, "theme"),
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { project, org } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    const view = await or404(buildView(db, project.id, data.buildId));
    const columns = await or404(
      parityShotsOf(
        db,
        view.build.id,
        { name: data.name, theme: data.theme },
        { crossProject: true },
      ),
    );
    const secret = imageSigningSecret();
    return {
      org,
      project,
      build: view.build,
      parity: await buildParityView({
        columns,
        orgId: project.orgId,
        store: blobStore(),
        sign: (key) => signedImagePath(`orgs/${project.orgId}/${key}`, secret),
      }),
    };
  });
