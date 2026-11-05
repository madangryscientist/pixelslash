/*
 * The pricing page's words. PixelSlash costs nothing today and there is no paid plan to buy.
 *
 * TODO(PS-261): Jacobus to review the wording of COMMITMENT before the site is published; it is a
 * promise about what paid hosting will and will not be, so it is his to phrase.
 */

/** The page's one statement, and the sentence under it. */
export const STATEMENT = "Free, and you can run all of it yourself.";
export const LEAD =
  "There is no paid plan to buy. The whole product is in the open-source repository.";

/** The one action the page asks for, and where it goes. */
export const ACTION = { label: "Self-host it", href: "/self-host" } as const;

/** The one promise about paid hosting: it buys having us run it, never a feature. */
export const COMMITMENT =
  "No feature will ever sit behind a paid plan. Paid hosting, when it comes, pays for us running PixelSlash for you; everything it runs is in the open-source code you can host yourself.";

export const FACTS = [
  {
    title: "Free and open source",
    body: "PixelSlash is MIT-licensed. The CLI, the diff engine and the review app are all in the repository, with nothing held back.",
  },
  {
    title: "Self-host all of it",
    body: "The review app runs in Docker, on your own Cloudflare account or on your own box. The self-host guide covers each.",
  },
  {
    title: "Paid hosting is planned, not available",
    body: "A paid service run by us is planned. It is not on sale: there is nothing to pay.",
  },
] as const;
