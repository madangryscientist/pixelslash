import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "#/api/handler";
import {
  blobStore,
  checkRunDeps,
  database,
  defaultDiffLocation,
  diffSidecarUrl,
  explainQueue,
  imageSigningSecret,
  minCliVersion,
  modelKeySecret,
} from "#/server/env";

const handle = ({ request }: { request: Request }) => {
  const db = database();
  return handleApi(request, {
    db,
    store: blobStore(),
    imageSecret: imageSigningSecret,
    minCliVersion: minCliVersion(),
    modelKeySecret: modelKeySecret(),
    explainQueue: explainQueue(),
    diffSidecar: diffSidecarUrl(),
    defaultDiffLocation,
    checkRuns: checkRunDeps(db),
  });
};

export const Route = createFileRoute("/api/v1/$")({
  server: { handlers: { GET: handle, POST: handle, PUT: handle, DELETE: handle } },
});
