// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type DecisionReply, type DecisionState, useDecision } from "#/lib/use-decision";

/**
 * A decision is one server call. The hook is driven with a stubbed `review` (the server fn) and
 * `go`, so the calls it makes are the whole proof: nothing here can read the build again.
 */

const calls: string[] = [];
let settle: (reply: DecisionReply) => void = () => {};
const mounted: ReturnType<typeof createRoot>[] = [];
const hook: {
  decide: (state: DecisionState) => void;
  busy: boolean;
  error: string | null;
} = { decide: () => {}, busy: false, error: null };

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount();
  calls.length = 0;
});

function Harness({
  reply,
  reviewable = true,
}: {
  reply: () => Promise<DecisionReply>;
  reviewable?: boolean;
}) {
  const result = useDecision({
    reviewable,
    review: (state) => {
      calls.push(`review ${state}`);
      return reply();
    },
    go: (id) => calls.push(`go ${id}`),
    toBuild: () => calls.push("build"),
  });
  useEffect(() => {
    Object.assign(hook, result);
  });
  return null;
}

async function mount(reply: () => Promise<DecisionReply>, reviewable = true) {
  const root = createRoot(document.createElement("div"));
  mounted.push(root);
  await act(async () => root.render(<Harness reply={reply} reviewable={reviewable} />));
}

const press = (state: DecisionState) =>
  act(async () => {
    hook.decide(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("deciding on the shot on screen", () => {
  it("an accept calls the server once, then moves to the shot it named", async () => {
    await mount(() => Promise.resolve({ buildStatus: "changes", nextToReviewId: "s2" }));
    await press("accepted");
    expect(calls).toEqual(["review accepted", "go s2"]);
  });

  it("a reply naming a next shot of a failed build sends the reviewer to the build page", async () => {
    await mount(() => Promise.resolve({ buildStatus: "failed", nextToReviewId: "s2" }));
    await press("accepted");
    expect(calls).toEqual(["review accepted", "build"]);
  });

  it("a reject goes to the build page", async () => {
    await mount(() => Promise.resolve({ buildStatus: "failed", nextToReviewId: "s2" }));
    await press("rejected");
    expect(calls).toEqual(["review rejected", "build"]);
  });

  it("a refused decision stays on the shot and says why", async () => {
    await mount(() => Promise.reject(new Error("build is errored")));
    await press("accepted");
    expect(calls).toEqual(["review accepted"]);
    expect([hook.busy, hook.error]).toEqual([false, "build is errored"]);
  });

  it("a second key while the first is in flight is ignored", async () => {
    const pending = new Promise<DecisionReply>((resolve) => (settle = resolve));
    await mount(() => pending);
    await press("accepted");
    await press("accepted");
    expect(calls).toEqual(["review accepted"]);
    expect(hook.busy).toBe(true);
    await act(async () => settle({ buildStatus: "changes", nextToReviewId: "s2" }));
    expect(calls).toEqual(["review accepted", "go s2"]);
  });

  it("a build that takes no decisions sends nothing", async () => {
    await mount(() => Promise.resolve({ buildStatus: "changes", nextToReviewId: "s2" }), false);
    await press("accepted");
    expect(calls).toEqual([]);
  });
});
