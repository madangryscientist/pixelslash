/** The line a run settled by identical bytes states instead of a pixel count (ob 1948). */
export const IDENTICAL_NOTE = "identical to baseline: same bytes, not diffed";

/** The figures of a run that was never diffed: just the two shots, which are the same file. */
export function identicalBody(): string {
  return `<div class="row" style="grid-template-columns: repeat(2, minmax(0, 1fr))">
      <figure><figcaption>Main</figcaption><div class="frame"><img src="main.png" alt="Main"></div></figure>
      <figure><figcaption>Branch</figcaption><div class="frame"><img src="branch.png" alt="Branch"></div></figure>
    </div>`;
}
