import type { CSSProperties, ReactNode } from "react";
import { Logo } from "#/components/logo";
import { TRADEMARK } from "#/content/docs";
import hero from "#/content/hero.json";
import { APP_LIVE, APP_URL, CONTACT, REPO_PUBLIC, REPO_URL } from "#/content/links";
import { PAGES } from "#/content/pages";

// The homepage's header, footer and hero demo (pages/home.tsx).

/** A style with CSS custom properties, which CSSProperties does not list. */
export function vars(style: CSSProperties & Record<`--${string}`, number | string>): CSSProperties {
  return style;
}

const CHANGES = hero.regions.filter((region) => region.kind === "change");
const pct = (value: number, of: number): string => `${(value / of) * 100}%`;

export function Header(): ReactNode {
  return (
    <header className="home-header sticky top-0 z-30">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        <a href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Logo size={26} />
          PixelSlash
        </a>
        <nav
          aria-label="Site"
          data-testid="site-nav"
          className="order-last -mx-5 flex w-[calc(100%+2.5rem)] gap-1 overflow-x-auto px-5 text-sm md:order-none md:mx-0 md:w-auto md:px-0"
        >
          {PAGES.map((page) => (
            <a
              key={page.to}
              href={page.to}
              aria-current={page.to === "/" ? "page" : undefined}
              className="home-nav-link whitespace-nowrap rounded-full px-3 py-1.5"
            >
              {page.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {APP_LIVE && (
            <a href={APP_URL} className="home-btn home-btn-ghost text-sm">
              Sign in
            </a>
          )}
          <a href="/self-host" className="home-btn home-btn-primary text-sm">
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}

/** Main, wiped into Branch by the slash; the boxes are where the run found its regions. */
export function Demo(): ReactNode {
  return (
    <figure className="home-demo-wrap mx-auto mt-12 max-w-5xl">
      <div className="home-window">
        <div className="home-window-bar">
          <span />
          <span />
          <span />
          <p>northwind.test/billing</p>
        </div>
        <div className="home-demo" style={{ aspectRatio: `${hero.width} / ${hero.height}` }}>
          <img src="/hero/main.png" alt="" width={hero.width} height={hero.height} />
          <div className="home-demo-branch">
            <img src="/hero/branch.png" alt="" width={hero.width} height={hero.height} />
            {CHANGES.map((region, index) => (
              <span
                key={`${region.x},${region.y}`}
                className="home-region"
                style={vars({
                  left: pct(region.x, hero.width),
                  top: pct(region.y, hero.height),
                  width: pct(region.w, hero.width),
                  height: pct(region.h, hero.height),
                  "--i": index,
                })}
              />
            ))}
          </div>
          <div className="home-slash" aria-hidden="true" />
          <span className="home-chip home-chip-main">Main</span>
          <span className="home-chip home-chip-branch">Branch</span>
        </div>
      </div>
      <div className="home-readout" aria-hidden="true">
        <span className="home-count" style={vars({ "--to": hero.changedPixels })} />
        <span>changed pixels</span>
        <span className="home-dot" />
        <span>{CHANGES.length} regions</span>
      </div>
      <figcaption className="mx-auto mt-4 max-w-2xl text-center text-sm text-(--home-sub)">
        A real run, not a mock-up: <code>pixelslash --live --local</code> on a billing page at{" "}
        {hero.width}×{hero.height}. It found {hero.changedPixels} changed pixels in {CHANGES.length}{" "}
        regions: the price, the button, the storage bar and its label.
      </figcaption>
    </figure>
  );
}

export function Footer(): ReactNode {
  return (
    <footer data-testid="footer" className="home-footer px-5 py-12 text-sm">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <a href="/" className="flex items-center gap-2 font-semibold text-(--home-text)">
            <Logo size={20} />
            PixelSlash
          </a>
          <span>MIT licence</span>
          <a href={`mailto:${CONTACT}`} className="home-link">
            {CONTACT}
          </a>
          {REPO_PUBLIC ? (
            <a href={REPO_URL} className="home-link" data-testid="source-status">
              GitHub
            </a>
          ) : (
            <span data-testid="source-status">Source opens at launch</span>
          )}
        </div>
        <span data-testid="trademark">{TRADEMARK}</span>
      </div>
    </footer>
  );
}
