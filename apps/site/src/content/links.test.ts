import { describe, expect, test } from "vitest";
import { APP_URL, REPO_URL, resolveHref } from "./links.ts";

const CLOSED = { repoPublic: false, appLive: false };
const OPEN = { repoPublic: true, appLive: true };

describe("resolveHref", () => {
  test("a repo file the site renders goes to its page, anchor kept", () => {
    expect(resolveHref("docs/cli.md#uploading-to-a-server", "README.md", CLOSED)).toBe(
      "/docs/upload#uploading-to-a-server",
    );
    expect(resolveHref("docs/getting-started.md", "README.md", CLOSED)).toBe(
      "/docs/getting-started",
    );
    expect(resolveHref("../../SECURITY.md", "apps/web/SELF-HOST.md", CLOSED)).toBe("/security");
    expect(resolveHref("SELF-HOST.md", "apps/web/README.md", CLOSED)).toBe("/self-host");
  });

  test("an #anchor inside cli.md stays put on its own page and names the page it is on otherwise", () => {
    expect(resolveHref("#uploading-to-a-server", "docs/cli.md", CLOSED, "upload")).toBe(
      "#uploading-to-a-server",
    );
    expect(resolveHref("#uploading-to-a-server", "docs/cli.md", CLOSED, "api")).toBe(
      "/docs/upload#uploading-to-a-server",
    );
    expect(resolveHref("#fixing-a-flake-locally", "docs/cli.md", CLOSED, "capture")).toBe(
      "/docs/upload#fixing-a-flake-locally",
    );
  });

  test("a link to a heading cli.md does not have stops the build", () => {
    expect(() => resolveHref("docs/cli.md#no-such-heading", "README.md", CLOSED)).toThrow(
      /no heading #no-such-heading/,
    );
  });

  test("any other repo file is text while the repository is closed, its blob when open", () => {
    expect(resolveHref("README.md", "apps/web/SELF-HOST.md", CLOSED)).toBeNull();
    expect(resolveHref("README.md", "apps/web/SELF-HOST.md", OPEN)).toBe(
      `${REPO_URL}/blob/main/apps/web/README.md`,
    );
  });

  test("a link to the repository or its images waits for it to open", () => {
    const repo = `${REPO_URL}/security/advisories/new`;
    expect(resolveHref(repo, "SECURITY.md", CLOSED)).toBeNull();
    expect(resolveHref(repo, "SECURITY.md", OPEN)).toBe(repo);
    const image = "https://ghcr.io/madangryscientist/pixelslash-capture";
    expect(resolveHref(image, "docs/cli.md", CLOSED)).toBeNull();
  });

  test("the hosted app waits for it to go live", () => {
    expect(resolveHref(`${APP_URL}/builds`, "docs/cli.md", CLOSED)).toBeNull();
    expect(resolveHref(`${APP_URL}/builds`, "docs/cli.md", OPEN)).toBe(`${APP_URL}/builds`);
  });

  test("an anchor, a mailto and any other site pass through", () => {
    expect(resolveHref("#exit-codes", "SECURITY.md", CLOSED)).toBe("#exit-codes");
    expect(resolveHref("mailto:hello@hack-cove.com", "SECURITY.md", CLOSED)).toBe(
      "mailto:hello@hack-cove.com",
    );
    expect(resolveHref("https://bun.sh", "docs/cli.md", CLOSED)).toBe("https://bun.sh");
  });
});
