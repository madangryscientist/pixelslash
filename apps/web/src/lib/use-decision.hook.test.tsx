// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { type DecisionReply, type DecisionState, useDecision } from "#/lib/use-decision";
import { act, renderHook } from "#/test/render";

/**
 * A decision is one server call. The hook is driven with a stubbed `review` (the server fn) and
 * `go`, so the calls it makes are the whole proof: nothing here can read the build again.
 */

const calls: string[] = [];
let settle: (reply: DecisionReply) => void = () => {};
let hook: { current: ReturnType<typeof useDecision> };

afterEach(() => {
  calls.length = 0;
});

function mount(reply: () => Promise<DecisionReply>, reviewable = true) {
  ({ result: hook } = renderHook(() =>
    useDecision({
      reviewable,
      review: (state) => {
        calls.push(`review ${state}`);
        return reply();
      },
      go: (id) => calls.push(`go ${id}`),
      toBuild: () => calls.push("build"),
    }),
  ));
}

const press = (state: DecisionState) =>
  act(async () => {
    hook.current.decide(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("deciding on the shot on screen", () => {
  it("an accept calls the server once, then moves to the shot it named", async () => {
    mount(() => Promise.resolve({ buildStatus: "changes", nextToReviewId: "s2" }));
    await press("accepted");
    expect(calls).toEqual(["review accepted", "go s2"]);
  });

  it("a reply naming a next shot of a failed build sends the reviewer to the build page", async () => {
    mount(() => Promise.resolve({ buildStatus: "failed", nextToReviewId: "s2" }));
    await press("accepted");
    expect(calls).toEqual(["review accepted", "build"]);
  });

  it("a reject goes to the build page", async () => {
    mount(() => Promise.resolve({ buildStatus: "failed", nextToReviewId: null }));
    await press("rejected");
    expect(calls).toEqual(["review rejected", "build"]);
  });

  it("a refused decision stays on the shot and says why", async () => {
    mount(() => Promise.reject(new Error("build is errored")));
    await press("accepted");
    expect(calls).toEqual(["review accepted"]);
    expect([hook.current.busy, hook.current.error]).toEqual([false, "build is errored"]);
  });

  it("a second key while the first is in flight is ignored", async () => {
    const pending = new Promise<DecisionReply>((resolve) => (settle = resolve));
    mount(() => pending);
    // Both keys land in one task, before React re-renders with `busy` set.
    await act(async () => {
      hook.current.decide("accepted");
      hook.current.decide("accepted");
    });
    expect(calls).toEqual(["review accepted"]);
    expect(hook.current.busy).toBe(true);
    await act(async () => settle({ buildStatus: "changes", nextToReviewId: "s2" }));
    expect(calls).toEqual(["review accepted", "go s2"]);
  });

  it("a build that takes no decisions sends nothing", async () => {
    mount(() => Promise.resolve({ buildStatus: "changes", nextToReviewId: "s2" }), false);
    await press("accepted");
    expect(calls).toEqual([]);
  });
});
