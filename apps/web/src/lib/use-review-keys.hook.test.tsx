// @vitest-environment happy-dom
import { startTransition, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useReviewKeys } from "#/lib/use-review-keys";

/**
 * A key typed after a navigation commits and before React runs that render's passive effects must
 * act on the shot now on screen. The harness commits shot "s3" in a transition (a router navigation
 * is one) and types the key from a layout effect, which runs in the commit and so always before any
 * passive effect: the window the old listener, re-bound by a passive effect, left open.
 */

const calls: string[] = [];
let done: (() => void) | null = null;
const mounted: ReturnType<typeof createRoot>[] = [];

beforeAll(() => {
  // React only waits for act() in an environment that says it is one; this test commits without it.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount();
  calls.length = 0;
});

function Shot({ id, nextId, previousId, typeOnCommit }: Props) {
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
    done?.();
  }, [typeOnCommit]);
  return null;
}

type Props = { id: string; nextId: string; previousId: string; typeOnCommit?: string[] };

const two: Props = { id: "s2", nextId: "s3", previousId: "s1" };
const three: Props = { id: "s3", nextId: "s1", previousId: "s2" };

/** Mount shot 2 with its effects bound, then commit shot 3 typing `keys` as it commits. */
async function navigateTyping(keys: string[]) {
  const root = createRoot(document.createElement("div"));
  mounted.push(root);
  // A synchronous commit runs its passive effects before it returns, so the listener is bound.
  flushSync(() => root.render(<Shot {...two} />));
  const typed = new Promise<void>((resolve) => (done = resolve));
  startTransition(() => root.render(<Shot {...three} typeOnCommit={keys} />));
  await typed;
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
