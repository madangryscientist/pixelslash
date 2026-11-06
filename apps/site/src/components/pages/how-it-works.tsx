import {
  Text,
  Caption,
  CodeBlock,
  ProseLayout,
  Section,
  Step,
  Steps,
  TextLink,
} from "@hackcove/ui-react";
import type { ReactNode } from "react";

/** The four questions a visitor comes with; the figures are bench/results/2026-10-20.md. */
function WhoFor(): ReactNode {
  return (
    <Section title="Who it is for, and what it costs">
      <Text as="p">
        PixelSlash is for developers and teams who ship web pages and want to see what a change did
        to them before it merges, without writing stories or signing up for a service.
      </Text>
      <Text as="p">
        It replaces a hosted visual-review service such as Chromatic, Percy or Argos: the run above
        on your machine or CI runner, and the review on a server you run.{" "}
        <TextLink href="/compare">The comparison</TextLink> lists where it is still behind.
      </Text>
      <Text as="p">
        It is free: MIT-licensed, with all of it in the repository and no paid plan to buy. A paid
        service run by us is planned; it is not on sale.
      </Text>
      <Text as="p">
        It differs in where the work happens: a local run needs no server, and uploads nothing
        unless you name a hosted judge. On the held-out half of our own benchmark, measured
        2026-10-20, it caught 42 of 45 real changes and wrongly flagged 11 of 36 noise pairs; Argos,
        on the same pairs, caught 37 and flagged 24.
      </Text>
    </Section>
  );
}

/** Each step is what docs/cli.md says the run does, in its order; the numbers are the engine's defaults. */
export function HowItWorksPage(): ReactNode {
  return (
    <ProseLayout title="How it works" subtitle="One run: two shots, a diff, a report." gap="lg">
      <Steps>
        <Step title="Capture Main and Branch">
          Playwright opens both URLs, or you hand it two PNGs. Each capture waits for the page to
          settle (fonts, images, network idle, two animation frames) and fails after a timeout
          rather than shooting early or hanging. The command does not start a dev server: both URLs
          must already be up.
        </Step>
        <Step title="Diff the pixels, perceptually">
          A pixel counts as changed only when its colour moves by more than a small threshold and it
          is not an anti-aliased edge in either shot. If the two shots differ in size, only the
          overlapping rectangle is diffed and the report states both sizes.
        </Step>
        <Step title="Group the change into regions">
          Changed pixels with up to 48 px clear between them are one region; a box under 4 px is a
          speck and is dropped. A faint, uneven region is labelled noise and a sub-pixel move is
          labelled shift: both stay in the report, and neither makes the run count as changed.
        </Step>
        <Step title="Write the report">
          report.html shows Main, Branch and the Diff, cropped to the changed region, with the
          counts and both sizes. It opens from disk: nothing is uploaded.
        </Step>
      </Steps>
      <Section title="A real report">
        <img
          src="/report.png"
          alt="The report.html of the run below: Main, Branch and Diff of a card whose background turned yellow"
          width={1200}
          height={960}
          className="w-full rounded-lg border border-slate-200 shadow-sm"
        />
        {/* The numbers below are what that run printed; regenerating public/report.png means re-reading them. */}
        <Caption as="p">
          A real run, not a mock-up: the repository's own fixtures/pages/live.html against
          local.html, shot in Chromium at 1280×720. It printed 19103 changed pixels and one changed
          region.
        </Caption>
        <CodeBlock language="bash" label="bash" copy>
          {[
            "bun run pixelslash -- --live http://localhost:4391/live.html \\",
            "  --local http://localhost:4391/local.html --out out",
            "pixelslash: 19103 changed pixels",
          ].join("\n")}
        </CodeBlock>
      </Section>
      <Section title="Exit codes">
        <Text as="p">
          0 means the run finished, whatever it found in pixels. 1 means a design-system judge found
          new violations on Branch. 2 is a usage error. A crash never exits 1, so CI can read the
          code.{" "}
          <TextLink href="/docs/signing-in#exit-codes-and-the-failed-line">The full list</TextLink>{" "}
          is in the docs.
        </Text>
      </Section>
      <Section title="Then, if you want a person to decide">
        <Text as="p">
          pixelslash upload sends the shots to a PixelSlash review server you run. It diffs them
          against the default branch, holds the build for review and reports a GitHub check, and
          pixelslash status --wait blocks CI until someone accepts or rejects it.{" "}
          <TextLink href="/self-host">Self-host the server</TextLink> or{" "}
          <TextLink href="/docs/upload#uploading-to-a-server">read how uploads work</TextLink>.
        </Text>
      </Section>
      <WhoFor />
    </ProseLayout>
  );
}
