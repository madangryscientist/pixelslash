import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "#/api/handler";
import {
  apiRateLimit,
  blobStore,
  checkRunDeps,
  database,
  defaultDiffLocation,
  diffLimitMpx,
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
    diffLimitMpx: diffLimitMpx(),
    defaultDiffLocation,
    checkRuns: checkRunDeps(db),
    rateLimit: apiRateLimit(),
  });
};

export const Route = createFileRoute("/api/v1/$")({
  server: { handlers: { GET: handle, POST: handle, PUT: handle, DELETE: handle } },
});
