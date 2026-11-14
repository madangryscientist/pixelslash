import {
  Button,
  Caption,
  Card,
  CardGrid,
  CodeBlock,
  Container,
  Pill,
  TextLink,
} from "@hackcove/ui-react";
import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { Demo } from "#/components/pages/home-parts";
import { REPO_PUBLIC, REPO_URL } from "#/content/links";
import { STAGE_LINE } from "#/content/stage";

/*
 * The homepage is marketing, not an admin screen: its controls and cards are @hackcove/ui-react
 * parts, and what no part draws (the gradients, the demo, the steps across the page) is Tailwind and
 * home.css, in the visitor's scheme. It carries its own footer. The header is the shared Shell's, as
 * on every page. The motion is CSS only and stands still for prefers-reduced-motion.
 */

/** What the CLI does, each one a section of docs/cli.md; the anchors are checked by the smoke test. */
export const FEATURES = [
  {
    title: "Two pages, one diff",
    body: "Shoot Main and Branch with Playwright, or hand it PNGs you already have. It writes a report.html that shows what changed.",
    href: "/how-it-works",
    icon: "capture",
  },
  {
    title: "A perceptual diff",
    body: "Anti-aliasing, faint noise and sub-pixel shifts are told apart from a real change. Our benchmark results are on the How it works page.",
    href: "/how-it-works",
    icon: "diff",
  },
  {
    title: "Many pages",
    body: "Point it at a file of paths and it compares each page. The compare command diffs two snapshot directories.",
    href: "/docs/compare-dirs#comparing-two-snapshot-dirs",
    icon: "baseline",
  },
  {
    title: "Snapshots in CI",
    body: "Every route is shot in a pinned image. Each shot records what rendered it, so one from a different setup is named as such.",
    href: "/docs/capture#snapshot-capture-the-pinned-image",
    icon: "ci",
  },
  {
    title: "A review server",
    body: "Uploading sends shots to a PixelSlash server you run. It holds the build for a person to review and reports a GitHub check.",
    href: "/docs/upload#uploading-to-a-server",
    icon: "self-host",
  },
  {
    title: "A design-system judge",
    body: "Each shot can be checked against your component images by a vision model. With no judge installed, it says so and invents nothing.",
    href: "/docs/judge",
    icon: "review",
  },
] as const;

const STEPS = [
  { title: "Capture", body: "Main and Branch, shot by Playwright once each page has settled." },
  { title: "Diff", body: "A perceptual diff, clustered into regions you can read." },
  { title: "Review", body: "A report.html on your machine, or a build on your own server." },
] as const;

const COMMANDS = [
  "npm i -D @hackcove/pixelslash",
  "npx @hackcove/pixelslash --live-png main.png --local-png branch.png --out out",
  "npx @hackcove/pixelslash install-browser",
] as const;

function Hero(): ReactNode {
  return (
    <section className="relative px-5 pt-12 pb-6 md:pt-16">
      <div className="home-aurora home-aurora-hero" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="home-grid" aria-hidden="true" />
      <div className="relative mx-auto max-w-4xl text-center">
        <p className="home-rise">
          <Pill tone="emerald" dot round>
            Free · Source available · Elastic License 2.0 · Local first
          </Pill>
        </p>
        <h1 className="home-rise mt-6 text-5xl leading-[1.05] font-bold tracking-tight md:text-[4.25rem]">
          See what your change <span className="home-gradient-text">did to the page.</span>
        </h1>
        <p className="home-rise mx-auto mt-6 max-w-2xl text-lg text-(--home-sub) md:text-xl">
          PixelSlash pixel-diffs Main against Branch and writes a report of what changed. It runs on
          your machine, for free.
        </p>
        <p className="home-rise mt-4 text-balance">
          <Caption data-testid="stage">{STAGE_LINE}</Caption>
        </p>
        <div className="home-rise mt-9 flex flex-wrap justify-center gap-3">
          <Button href="/self-host" size="lg">
            Self-host it <span aria-hidden="true">→</span>
          </Button>
          <Button href="/docs" variant="outline" size="lg">
            Read the docs
          </Button>
        </div>
      </div>
      <Demo />
    </section>
  );
}

function Steps(): ReactNode {
  return (
    <section className="px-5 pt-6 pb-14">
      <p className="home-reveal mx-auto mb-8 max-w-4xl text-center text-(--home-sub)">
        PixelSlash runs in place of a hosted visual-review service such as Chromatic, Percy or
        Argos. It is a source-available CLI that needs no Storybook and no account, with no paid
        plan to buy. <TextLink href="/compare">Where it is still behind</TextLink>.
      </p>
      <ol className="home-steps mx-auto grid max-w-5xl gap-6 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="home-reveal home-step">
            <span className="home-step-n">{index + 1}</span>
            <h2 className="mt-4 text-xl font-semibold">{step.title}</h2>
            <p className="mt-2 text-(--home-sub)">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Features(): ReactNode {
  return (
    <section className="py-14">
      <Container>
        <div data-testid="home-column">
          <h2 className="home-reveal text-center text-3xl font-bold tracking-tight md:text-5xl">
            What it does
          </h2>
          <div className="home-cards mt-12">
            <CardGrid columns={3}>
              {FEATURES.map((feature) => (
                // A one-cell grid, so the card fills the row's height.
                <div key={feature.title} className="home-reveal grid">
                  <Card href={feature.href} icon={feature.icon} size="lg">
                    <h3 className="text-lg font-semibold">{feature.title}</h3>
                    <p className="mt-2 text-(--home-sub)">{feature.body}</p>
                    <span
                      className="home-more mt-4 inline-block text-sm font-semibold"
                      aria-hidden="true"
                    >
                      Read more →
                    </span>
                  </Card>
                </div>
              ))}
            </CardGrid>
          </div>
        </div>
      </Container>
    </section>
  );
}

function Checkout(): ReactNode {
  return (
    <section className="py-14">
      <Container>
        <div data-testid="home-column" className="grid items-center gap-10 lg:grid-cols-[2fr_3fr]">
          <div className="home-reveal">
            <h2 className="text-3xl font-bold tracking-tight md:text-5xl">Install it from npm</h2>
            <p className="mt-5 text-lg text-(--home-sub)">
              It is on npm as <code>@hackcove/pixelslash</code>, and the command is{" "}
              <code>pixelslash</code>. The CLI runs on{" "}
              <TextLink href="https://bun.sh">Bun</TextLink>, so Bun must be on your PATH;{" "}
              <code>npx</code> starts it. PNG mode needs no browser; for URL capture run{" "}
              <code>install-browser</code> once per machine.
            </p>
            <p className="mt-4 text-(--home-sub)">
              To run it from a clone instead, <code>bun install</code> and then{" "}
              <code>bun run pixelslash -- …</code> in a checkout of{" "}
              {REPO_PUBLIC ? <TextLink href={REPO_URL}>the repository</TextLink> : "the repository"}
              .
            </p>
          </div>
          <div className="home-reveal min-w-0">
            <CodeBlock label="bash" language="bash" lines={[...COMMANDS]} overflow="wrap" copy />
          </div>
        </div>
      </Container>
    </section>
  );
}

function Local(): ReactNode {
  return (
    <section className="pt-14 pb-20">
      <Container>
        <div data-testid="home-column" className="home-reveal home-band">
          <h2 className="text-3xl font-bold tracking-tight md:text-5xl">
            Your pixels stay <span className="home-gradient-text">on your machine.</span>
          </h2>
          <p
            data-testid="local-band-copy"
            className="mx-auto mt-5 max-w-[60ch] text-lg text-(--home-sub)"
          >
            A page shot leaves the machine only when you ask, and an upload goes only to the server
            your project names. If a project sets its own AI model, the model gets the three crops
            of a changed region, never a whole shot.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Button href="/security" variant="outline">
              Security
            </Button>
            <Button href="/how-it-works">
              How it works <span aria-hidden="true">→</span>
            </Button>
          </div>
        </div>
      </Container>
    </section>
  );
}

/**
 * Marks each `.home-reveal` as it scrolls into view. What is already on screen is marked before
 * `data-motion` turns the hiding on, so nothing blinks out; with no script nothing is hidden.
 */
function useReveal(): RefObject<HTMLDivElement | null> {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const targets = [...element.querySelectorAll(".home-reveal")];
    for (const target of targets)
      if (target.getBoundingClientRect().top < window.innerHeight) target.classList.add("is-in");
    element.dataset["motion"] = "";
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    for (const target of targets) if (!target.classList.contains("is-in")) observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return root;
}

export function HomePage(): ReactNode {
  const root = useReveal();
  return (
    <div className="home" ref={root}>
      <Hero />
      <Steps />
      <Features />
      <Checkout />
      <Local />
    </div>
  );
}
