import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "#/api/handler";
import { blobStore, database, imageSigningSecret, minCliVersion } from "#/server/env";

const handle = ({ request }: { request: Request }) =>
  handleApi(request, {
    db: database(),
    store: blobStore(),
    imageSecret: imageSigningSecret,
    minCliVersion: minCliVersion(),
  });

export const Route = createFileRoute("/api/v1/$")({
  server: { handlers: { GET: handle, POST: handle, PUT: handle, DELETE: handle } },
});
