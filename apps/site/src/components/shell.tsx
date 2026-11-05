import {
  AppShell,
  AppShellBrand,
  Button,
  Caption,
  Cluster,
  ColourSchemeToggle,
  Tabs,
  Stack,
  TextLink,
} from "@hackcove/ui-react";
import type { ReactNode } from "react";
import { TRADEMARK } from "#/content/docs";
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

function Footer(): ReactNode {
  return (
    <Stack gap="sm" data-testid="footer">
      <Cluster gap="md">
        <span>MIT licence</span>
        <TextLink href={`mailto:${CONTACT}`}>{CONTACT}</TextLink>
        <SourceLink />
      </Cluster>
      <span data-testid="trademark">{TRADEMARK}</span>
    </Stack>
  );
}

/**
 * The frame every page sits in: the brand, the nav row, the page, the footer. The homepage's sections
 * run the full width and it draws its own footer, so it bleeds and takes none from here.
 */
export function Shell({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}): ReactNode {
  const isHome = pathname === "/";
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
      subnav={
        // One scrolling row on a phone rather than wrapping out of the fixed-height bar.
        <div className="-mx-1 overflow-x-auto px-1 [&>nav]:flex-nowrap [&_a]:whitespace-nowrap">
          <Tabs variant="pill" items={items} label="Site" size="sm" data-testid="site-nav" />
        </div>
      }
      footer={isHome ? undefined : <Footer />}
      bleed={isHome}
    >
      {children}
    </AppShell>
  );
}
