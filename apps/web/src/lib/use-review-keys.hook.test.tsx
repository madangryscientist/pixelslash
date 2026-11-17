// @vitest-environment happy-dom
import { startTransition, useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useReviewKeys } from "#/lib/use-review-keys";
import { act, renderHook } from "#/test/render";

/**
 * A key typed after a navigation commits and before React runs that render's passive effects must
 * act on the shot now on screen. The harness commits shot "s3" in a transition (a router navigation
 * is one) and types the key from a layout effect, which runs in the commit and so always before any
 * passive effect: the window the old listener, re-bound by a passive effect, left open.
 */

const calls: string[] = [];

afterEach(() => {
  calls.length = 0;
});

function useShot({ id, nextId, previousId, typeOnCommit }: Props) {
  useReviewKeys({
    canDecide: true,
    nextId,
    previousId,
    go: (target) => calls.push(`go ${target} from ${id}`),
    decide: (state) => calls.push(`${state} ${id}`),
    help: () => {},
    helpOpen: false,
  });
  useLayoutEffect(() => {
    if (!typeOnCommit) return;
    for (const key of typeOnCommit) window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  }, [typeOnCommit]);
}

type Props = { id: string; nextId: string; previousId: string; typeOnCommit?: string[] };

const two: Props = { id: "s2", nextId: "s3", previousId: "s1" };
const three: Props = { id: "s3", nextId: "s1", previousId: "s2" };

/** Mount shot 2 with its effects bound, then commit shot 3 typing `keys` as it commits. */
async function navigateTyping(keys: string[]) {
  // The first render's act runs its passive effects before it returns, so the listener is bound.
  const { rerender } = renderHook(useShot, { initialProps: two });
  await act(async () => startTransition(() => rerender({ ...three, typeOnCommit: keys })));
}

describe("useReviewKeys, in the commit that shows another shot", () => {
  it("decides the shot on screen, not the one just left", async () => {
    await navigateTyping(["a"]);
    expect(calls).toEqual(["accepted s3"]);
  });

  it("walks from the shot on screen", async () => {
    await navigateTyping(["j", "k"]);
    expect(calls).toEqual(["go s1 from s3", "go s2 from s3"]);
  });
});
