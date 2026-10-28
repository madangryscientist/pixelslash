import {
  ButtonLink,
  Card,
  CardGrid,
  Cluster,
  CodeBlock,
  Display,
  Lead,
  Section,
  Stack,
  TextLink,
} from "@hackcove/ui";
import type { ReactNode } from "react";
import { REPO_PUBLIC } from "#/content/links";

/** What the CLI does, each one a section of docs/cli.md; the anchors are checked by the smoke test. */
const FEATURES = [
  {
    title: "Two pages, one diff",
    body: "Shoot Main and Branch with Playwright, or hand it PNGs you already have. It writes a report.html that shows what changed.",
    href: "/how-it-works",
  },
  {
    title: "A perceptual diff",
    body: "Anti-aliasing, faint noise and sub-pixel shifts are told apart from a real change, so a report is about the change.",
    href: "/how-it-works",
  },
  {
    title: "Many pages",
    body: "--routes compares a list of paths, and compare diffs two snapshot directories.",
    href: "/docs#comparing-two-snapshot-dirs",
  },
  {
    title: "Snapshots in CI",
    body: "pixelslash capture shoots every route in a pinned image, so the same commit renders the same pixels on any runner.",
    href: "/docs#snapshot-capture-the-pinned-image",
  },
  {
    title: "A review server",
    body: "pixelslash upload sends shots to a PixelSlash server, which holds the build for a person to review and reports a GitHub check.",
    href: "/docs#uploading-to-a-server",
  },
  {
    title: "A design-system judge",
    body: "--ds checks each shot against your component rasters with a vision model. With no judge installed it says so and invents nothing.",
    href: "/docs",
  },
] as const;

export function HomePage(): ReactNode {
  return (
    <Stack gap="xl">
      <Stack gap="md" width="narrow">
        <Display>See what your change did to the page.</Display>
        <Lead>
          PixelSlash takes two versions of a page, Main and Branch, pixel-diffs them and writes a
          report that shows what changed. It is a standalone CLI: no Storybook and no account.
          Nothing leaves your machine unless you ask it to, by uploading to a server or naming a
          hosted judge.
        </Lead>
        <Cluster gap="sm">
          <ButtonLink href="/self-host">Self-host it</ButtonLink>
          <ButtonLink href="/docs" variant="outline">
            Read the docs
          </ButtonLink>
        </Cluster>
      </Stack>
      <img
        src="/report.png"
        alt="A real PixelSlash report: Main, Branch and Diff of a card whose background changed, cropped to the changed region"
        width={1200}
        height={960}
        className="w-full max-w-4xl rounded-lg border border-slate-200 shadow-sm"
      />
      <Section title="Run it from a checkout" width="narrow">
        <Lead>
          The CLI runs on{" "}
          <TextLink href="https://bun.sh" external>
            Bun
          </TextLink>
          . It is not on the npm registry yet, so it runs from a checkout of the repository
          {REPO_PUBLIC ? "." : ", which opens at launch."}
        </Lead>
        <CodeBlock language="bash" label="bash">
          {[
            "bun install",
            "bun run pixelslash -- install-browser   # once, for URL capture",
            "bun run pixelslash -- --live-png main.png --local-png branch.png --out out",
          ].join("\n")}
        </CodeBlock>
      </Section>
      <Section title="What it does">
        <CardGrid columns={3}>
          {FEATURES.map((feature) => (
            <Card key={feature.title} title={feature.title} href={feature.href}>
              {feature.body}
            </Card>
          ))}
        </CardGrid>
      </Section>
    </Stack>
  );
}
