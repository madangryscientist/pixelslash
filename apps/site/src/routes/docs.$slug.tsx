import { createFileRoute, notFound } from "@tanstack/react-router";
import { DocPage } from "#/components/pages/docs";
import { findPage } from "#/content/docs-map";

export const Route = createFileRoute("/docs/$slug")({
  loader: ({ params }) => {
    if (findPage(params.slug) === undefined) throw notFound();
    return null;
  },
  head: ({ params }) => ({
    meta: [{ title: `${findPage(params.slug)?.title ?? "Docs"} · Docs · PixelSlash` }],
  }),
  component: function DocsSlugPage() {
    const { slug } = Route.useParams();
    return <DocPage slug={slug} />;
  },
});
