/**
 * A build with this many changed shots (`diff_status = changed`) or more gets no AI summary
 * (ob 1833): a paragraph over dozens of changes says little, and the call is slow and dear.
 * Region labels are not limited by it. Client-safe: the build page reads it too.
 */
export const SUMMARY_CHANGE_LIMIT = 10;

export const tooManyChanges = (changed: number) => changed >= SUMMARY_CHANGE_LIMIT;

/** The page's words in place of a summary. */
export const noSummaryReason = (changed: number) =>
  `No AI summary: ${changed} changed shots (summaries are made for builds with fewer than ${SUMMARY_CHANGE_LIMIT}).`;
