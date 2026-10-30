import { createFileRoute } from "@tanstack/react-router";
import { blobStore, imageSigningSecret } from "#/server/env";
import { verifySignedImagePath } from "#/storage/signed";

/**
 * Serves one PNG from the private bucket behind a short-lived signature. Every failure is the
 * same 404: a missing object, a tampered key and an expired signature are indistinguishable, so
 * the route never confirms what the bucket holds.
 */
export const Route = createFileRoute("/images/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        // The key is the path after `/images/`; a URL-encoded key is decoded the same way a
        // router param would be.
        let key: string;
        try {
          key = decodeURIComponent(url.pathname.replace(/^\/images\//, ""));
        } catch {
          return new Response("not found", { status: 404 });
        }
        const ok = await verifySignedImagePath({
          key,
          expires: url.searchParams.get("exp"),
          sig: url.searchParams.get("sig"),
          secret: imageSigningSecret(),
        });
        if (!ok) return new Response("not found", { status: 404 });
        const body = await blobStore().get(key);
        if (!body) return new Response("not found", { status: 404 });
        return new Response(body, {
          headers: {
            "content-type": "image/png",
            // The signature is short-lived; the browser may reuse the bytes for its duration.
            "cache-control": "private, max-age=300",
          },
        });
      },
    },
  },
});
