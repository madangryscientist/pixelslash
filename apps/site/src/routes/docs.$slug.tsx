import { createFileRoute, notFound } from "@tanstack/react-router";
import { DocPage } from "#/components/pages/docs";
import { findPage } from "#/content/docs-map";
import { headFor } from "#/content/seo";

export const Route = createFileRoute("/docs/$slug")({
  // Imported here, not at the top: the docs' text is the page's chunk, not the site's entry.
  loader: async ({ params }) => {
    if (findPage(params.slug) === undefined) throw notFound();
    const { describePage, loadDoc } = await import("#/content/docs");
    // Loaded here, so the page renders its whole text at once on the server and on a navigation.
    return { description: describePage(params.slug, await loadDoc(params.slug)) };
  },
  head: ({ params, loaderData }) => {
    const title = `${findPage(params.slug)?.title ?? "Docs"} · Docs · PixelSlash`;
    return loaderData ? headFor(`/docs/${params.slug}`, title, loaderData.description) : {};
  },
  component: function DocsSlugPage() {
    const { slug } = Route.useParams();
    return <DocPage slug={slug} />;
  },
});
