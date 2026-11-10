/** Made at build time from docs/cli.md by `cli-meta.ts`. */
declare module "virtual:cli-meta" {
  /** GitHub anchor of a cli.md heading → the slug of the docs page that shows it. */
  export const ANCHOR_PAGE: Readonly<Record<string, string>>;
  /** cli.md from its `# title` up to its first H2: what the docs index leads with. */
  export const CLI_INTRO: string;
}

/** One loader per docs page cut from docs/cli.md, by slug. */
declare module "virtual:cli-pages" {
  /** A cli page's own markdown, and the anchors its headings have in the whole file, in order. */
  export const CLI_PAGES: Readonly<
    Record<string, () => Promise<{ MARKDOWN: string; IDS: readonly string[] }>>
  >;
}
