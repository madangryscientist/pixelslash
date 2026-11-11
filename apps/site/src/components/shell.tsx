import {
  AppShell,
  AppShellBrand,
  Button,
  Caption,
  ColourSchemeToggle,
  Container,
  Tabs,
  TextLink,
} from "@hackcove/ui-react";
import type { ReactNode } from "react";
import { useKeyboardScrollers } from "#/components/keyboard-scrollers";
import { TRADEMARK } from "#/content/trademark";
import { APP_LIVE, APP_URL, CONTACT, REPO_PUBLIC, REPO_URL } from "#/content/links";
import { PAGES } from "#/content/pages";
import { Wordmark } from "#/components/logo";

/** The class each scheme puts on <html>: Latte's scope for light, Mocha's for dark. */
export const SCHEMES = { light: "latte", dark: "dark" } as const;

/** Where the source is: a link once the repository is public (PS-257, PS-292), a plain sentence before. */
function SourceLink(): ReactNode {
  if (!REPO_PUBLIC) return <Caption data-testid="source-status">Source opens at launch</Caption>;
  return (
    <TextLink href={REPO_URL} external data-testid="source-status">
      GitHub
    </TextLink>
  );
}

function Controls(): ReactNode {
  return (
    <>
      <ColourSchemeToggle schemes={SCHEMES} size="sm" data-testid="theme-toggle" />
      {APP_LIVE && (
        <Button href={APP_URL} variant="outline" size="sm">
          Sign in
        </Button>
      )}
      <Button href="/self-host" size="sm">
        Get started
      </Button>
    </>
  );
}

/** The footer every page shares: the wordmark, the licence and contact lines, then the trademark line. */
function Footer(): ReactNode {
  return (
    <div data-testid="footer" className="home-footer flex flex-col gap-4 py-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <a href="/" className="flex items-center" aria-label="PixelSlash home">
          <Wordmark />
        </a>
        <span>Elastic License 2.0</span>
        <TextLink href={`mailto:${CONTACT}`}>{CONTACT}</TextLink>
        <SourceLink />
      </div>
      <span data-testid="trademark">{TRADEMARK}</span>
    </div>
  );
}

/**
 * An inner page's ground: the home's canvas with the same aurora and grid fading out over the top
 * of the page, so stepping from the home to any page keeps the look. The page itself sits in the
 * shell's own Container, over it.
 */
function PageArt({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="page-art">
      <div className="page-art-bg" aria-hidden="true">
        <div className="home-aurora">
          <span />
          <span />
          <span />
        </div>
        <div className="home-grid" />
      </div>
      <div className="py-8">
        <Container>{children}</Container>
      </div>
    </div>
  );
}

/**
 * The frame every page sits in: the brand, the nav, the page, the footer. The homepage's sections
 * run the full width. Every other page is drawn over the same ground (PageArt), and the shell
 * paints that ground under the footer too. The footer is the same on every page.
 */
export function Shell({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}): ReactNode {
  const isHome = pathname === "/";
  useKeyboardScrollers();
  const items = PAGES.map((page) => ({
    label: page.label,
    href: page.to,
    // A docs page (`/docs/upload`) keeps Docs marked in the nav.
    active: page.to === pathname || (page.to !== "/" && pathname.startsWith(`${page.to}/`)),
  }));
  return (
    <AppShell
      brand={<AppShellBrand href="/" label={<Wordmark />} />}
      controls={<Controls />}
      // One row from md: the nav sits between the brand and the controls. On a phone AppShell folds it
      // behind its Menu button; the controls stay in the header.
      nav={<Tabs variant="pill" items={items} label="Site" size="sm" data-testid="site-nav" />}
      footer={<Footer />}
      bleed
      data-art=""
    >
      {isHome ? children : <PageArt>{children}</PageArt>}
    </AppShell>
  );
}
