/** Made at build time from docs/cli.md by `cli-meta.ts`. */
declare module "virtual:cli-meta" {
  /** GitHub anchor of a cli.md heading → the slug of the docs page that shows it. */
  export const ANCHOR_PAGE: Readonly<Record<string, string>>;
  /** cli.md from its `# title` up to its first H2: what the docs index leads with. */
  export const CLI_INTRO: string;
}
