import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "#/api/handler";
import {
  blobStore,
  database,
  defaultDiffLocation,
  diffSidecarUrl,
  inProcessDiff,
  explainQueue,
  imageSigningSecret,
  minCliVersion,
  modelKeySecret,
} from "#/server/env";

const handle = ({ request }: { request: Request }) =>
  handleApi(request, {
    db: database(),
    store: blobStore(),
    imageSecret: imageSigningSecret,
    minCliVersion: minCliVersion(),
    modelKeySecret: modelKeySecret(),
    explainQueue: explainQueue(),
    diffSidecar: diffSidecarUrl(),
    diff: inProcessDiff(),
    defaultDiffLocation,
  });

export const Route = createFileRoute("/api/v1/$")({
  server: { handlers: { GET: handle, POST: handle, PUT: handle, DELETE: handle } },
});
