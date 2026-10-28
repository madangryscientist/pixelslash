import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { Demo, Footer, Header, vars } from "#/components/pages/home-parts";
import { REPO_PUBLIC } from "#/content/links";

/*
 * The homepage is marketing, not an admin screen, so it is drawn here in plain Tailwind and
 * home.css rather than with @hackcove/ui, and it carries its own header and footer. The other
 * pages keep the shared Shell. The motion is CSS only and stands still for prefers-reduced-motion.
 */

/** What the CLI does, each one a section of docs/cli.md; the anchors are checked by the smoke test. */
const FEATURES = [
  {
    title: "Two pages, one diff",
    body: "Shoot Main and Branch with Playwright, or hand it PNGs you already have. It writes a report.html that shows what changed.",
    href: "/how-it-works",
    icon: "◧",
  },
  {
    title: "A perceptual diff",
    body: "Anti-aliasing, faint noise and sub-pixel shifts are told apart from a real change, so a report is about the change.",
    href: "/how-it-works",
    icon: "◎",
  },
  {
    title: "Many pages",
    body: "--routes compares a list of paths, and compare diffs two snapshot directories.",
    href: "/docs#comparing-two-snapshot-dirs",
    icon: "▦",
  },
  {
    title: "Snapshots in CI",
    body: "pixelslash capture shoots every route in a pinned image, so the same commit renders the same pixels on any runner.",
    href: "/docs#snapshot-capture-the-pinned-image",
    icon: "⟳",
  },
  {
    title: "A review server",
    body: "pixelslash upload sends shots to a PixelSlash server, which holds the build for a person to review and reports a GitHub check.",
    href: "/docs#uploading-to-a-server",
    icon: "✓",
  },
  {
    title: "A design-system judge",
    body: "--ds checks each shot against your component rasters with a vision model. With no judge installed it says so and invents nothing.",
    href: "/docs",
    icon: "◈",
  },
] as const;

const STEPS = [
  { title: "Capture", body: "Main and Branch, shot by Playwright once each page has settled." },
  { title: "Diff", body: "A perceptual diff, clustered into regions you can read." },
  { title: "Review", body: "A report.html on your machine, or a build on your own server." },
] as const;

const COMMANDS = [
  "bun install",
  "bun run pixelslash -- install-browser   # once, for URL capture",
  "bun run pixelslash -- --live-png main.png --local-png branch.png --out out",
] as const;

function Hero(): ReactNode {
  return (
    <section className="relative px-5 pt-12 pb-20 md:pt-16">
      <div className="home-aurora" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="home-grid" aria-hidden="true" />
      <div className="relative mx-auto max-w-4xl text-center">
        <p className="home-pill home-rise">
          <span className="home-pulse" />
          Open source · MIT · Local first
        </p>
        <h1 className="home-rise mt-6 text-5xl leading-[1.05] font-bold tracking-tight md:text-[4.25rem]">
          See what your change <span className="home-gradient-text">did to the page.</span>
        </h1>
        <p className="home-rise mx-auto mt-6 max-w-2xl text-lg text-(--home-sub) md:text-xl">
          PixelSlash takes two versions of a page, Main and Branch, pixel-diffs them and writes a
          report that shows what changed. It is a standalone CLI: no Storybook and no account.
          Nothing leaves your machine unless you ask it to, by uploading to a server or naming a
          hosted judge.
        </p>
        <div className="home-rise mt-9 flex flex-wrap justify-center gap-3">
          <a href="/self-host" className="home-btn home-btn-primary home-btn-lg">
            Self-host it <span aria-hidden="true">→</span>
          </a>
          <a href="/docs" className="home-btn home-btn-ghost home-btn-lg">
            Read the docs
          </a>
        </div>
      </div>
      <Demo />
    </section>
  );
}

function Steps(): ReactNode {
  return (
    <section className="px-5 py-20">
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
    <section className="px-5 py-20">
      <div className="mx-auto max-w-6xl">
        <h2 className="home-reveal text-center text-3xl font-bold tracking-tight md:text-5xl">
          What it does
        </h2>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <a key={feature.title} href={feature.href} className="home-reveal home-card">
              <span className="home-card-icon" aria-hidden="true">
                {feature.icon}
              </span>
              <h3 className="mt-5 text-lg font-semibold">{feature.title}</h3>
              <p className="mt-2 text-(--home-sub)">{feature.body}</p>
              <span className="home-card-more" aria-hidden="true">
                Read more →
              </span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function Checkout(): ReactNode {
  return (
    <section className="px-5 py-20">
      <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[2fr_3fr]">
        <div className="home-reveal">
          <h2 className="text-3xl font-bold tracking-tight md:text-5xl">Run it from a checkout</h2>
          <p className="mt-5 text-lg text-(--home-sub)">
            The CLI runs on{" "}
            <a href="https://bun.sh" className="home-link">
              Bun
            </a>
            . It is not on the npm registry yet, so it runs from a checkout of the repository
            {REPO_PUBLIC ? "." : ", which opens at launch."}
          </p>
        </div>
        <div className="home-reveal home-window home-terminal">
          <div className="home-window-bar">
            <span />
            <span />
            <span />
            <p>bash</p>
          </div>
          <pre>
            {COMMANDS.map((command, index) => (
              <code
                key={command}
                className="home-type"
                style={vars({ "--i": index, "--n": command.length })}
              >
                <span className="home-prompt">$ </span>
                {command}
              </code>
            ))}
          </pre>
        </div>
      </div>
    </section>
  );
}

function Local(): ReactNode {
  return (
    <section className="px-5 py-20">
      <div className="home-reveal home-band mx-auto max-w-6xl">
        <h2 className="text-3xl font-bold tracking-tight md:text-5xl">
          Your pixels stay <span className="home-gradient-text">on your machine.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-(--home-sub)">
          Without <code>--upload</code>, no page shot leaves the machine. With it, shots go only to
          the server the project names, ours or your own. The one other place pixels can go is a
          project's own AI model, opt-in: the three crops of a changed region, never a whole shot.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <a href="/security" className="home-btn home-btn-ghost">
            Security
          </a>
          <a href="/how-it-works" className="home-btn home-btn-primary">
            How it works <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>
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
      <Header />
      <main>
        <Hero />
        <Steps />
        <Features />
        <Checkout />
        <Local />
      </main>
      <Footer />
    </div>
  );
}
