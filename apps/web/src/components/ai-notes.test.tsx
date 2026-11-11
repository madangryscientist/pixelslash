import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { AiExplanation, type JudgedShot } from "./ai-notes";

/** Only the fields the section reads; the rest of a snapshot row is not its business. */
const changed = (over: Partial<JudgedShot>): JudgedShot => ({
  diffStatus: "changed",
  aiReview: null,
  aiPending: false,
  aiError: null,
  reviewState: "pending",
  reviewedBy: null,
  ...over,
});

const text = (snapshot: JudgedShot) =>
  renderToStaticMarkup(<AiExplanation snapshot={snapshot} />).replace(/<[^>]+>/g, "");

test("a failed judge says it failed and why, never that there is no judge", () => {
  const out = text(changed({ aiError: "the model answered 502" }));
  expect(out).toContain("judge failed: the model answered 502. Review the pixels.");
  expect(out).not.toContain("no judge");
});

test("a failure that already ends in a full stop does not double it", () => {
  expect(text(changed({ aiError: "timed out." }))).toContain("judge failed: timed out. Review");
});

test("with no error and no explanation the shot is reviewed as plain pixels", () => {
  const out = text(changed({}));
  expect(out).toContain("skip: no judge. Review the pixels.");
  expect(out).not.toContain("judge failed");
});

test("a shot still waiting on the queue is explaining, whatever an earlier run said", () => {
  const out = text(changed({ aiPending: true, aiError: "old failure" }));
  expect(out).toContain("explaining…");
  expect(out).not.toContain("judge failed");
});
