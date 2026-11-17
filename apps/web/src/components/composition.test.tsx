// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { DiffResult } from "#/db/schema";
import { CompositionFocus, CompositionPanel, type Composition, findingsLine } from "./composition";
import { SnapshotViewer, type ViewState } from "./snapshot-viewer";

/**
 * A composition-only project's findings (the gaps and special cases a walk measured), as the shot
 * page draws and lists them: the two lists, the boxes on the Branch pane only, the link between a
 * box and its row, the boxes' own toggle with its legend, and the count on the build page's card.
 */

const composition: Composition = {
  library: "Hack Cove UI",
  gaps: [
    {
      kind: "class",
      selector: "#go",
      tag: "button",
      classes: ["mt-7"],
      style: null,
      box: { x: 10, y: 10, width: 10, height: 10 },
    },
  ],
  special: [
    {
      selector: "#logo",
      reason: "the brand mark is drawn by hand",
      box: { x: 0, y: 20, width: 20, height: 20 },
    },
  ],
};

/** A 40 x 40 px shot measured against an identical baseline: the boxes sit at quarters of it. */
const measured: DiffResult = {
  changedPixels: 0,
  antialiasedPixels: 0,
  ignoredPixels: 0,
  ignored: [],
  specks: { count: 0, pixels: 0 },
  regions: [],
  width: 40,
  height: 40,
  mainWidth: 40,
  mainHeight: 40,
  branchWidth: 40,
  branchHeight: 40,
  sizeChanged: false,
};

const view: ViewState = {
  mode: "side",
  onMode: () => {},
  scale: "fit",
  onScale: () => {},
  base: null,
  onBase: () => {},
};

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** The shot page's pieces in the order the route lays them out: the viewer, then the panel. */
function mount(result: DiffResult | null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <CompositionFocus>
        <SnapshotViewer
          snapshotId="s1"
          bases={null}
          name="hero"
          mainUrl="/main.png"
          branchUrl="/branch.png"
          diffUrl={null}
          result={result}
          removed={false}
          composition={composition}
          view={view}
          panel={null}
        />
        <CompositionPanel composition={composition} />
      </CompositionFocus>,
    ),
  );
}

const gapBox = () => host.querySelector<HTMLElement>('[data-testid="gap-box"]');
const specialBox = () => host.querySelector<HTMLElement>('[data-testid="special-box"]');
const legend = () => host.querySelector('[aria-label="Composition legend"]');
const toggle = () =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === "Composition");
const gapRow = (): HTMLElement => {
  const row = host.querySelector('[aria-label="Hack Cove UI gaps"] li')?.firstElementChild;
  if (!(row instanceof HTMLElement)) throw new Error("no gap row");
  return row;
};
/** The box, which the test then points at: a missing one fails here, not in the pointer call. */
const must = (el: HTMLElement | null): HTMLElement => {
  if (!el) throw new Error("not on the page");
  return el;
};

/** A pointer entering or leaving an element, the events React's enter and leave handlers read. */
function pointer(el: Element, kind: "enter" | "leave") {
  const [over, out] = [
    ["mouseover", "pointerover"],
    ["mouseout", "pointerout"],
  ] as const;
  const types = kind === "enter" ? over : out;
  act(() => {
    for (const type of types) el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

describe("a shot's composition findings on the shot page", () => {
  test("one gap and one special case are listed under the shot, each with its reason", () => {
    mount(measured);
    const text = host.textContent ?? "";
    expect(text).toContain("Hack Cove UI gaps on Branch (1)");
    expect(host.querySelector('[aria-label="Hack Cove UI gaps"]')?.textContent).toContain(
      "extra classes on a Hack Cove UI component: mt-7",
    );
    expect(text).toContain("Special cases on Branch (1)");
    expect(host.querySelector('[aria-label="Special cases"]')?.textContent).toContain(
      "the brand mark is drawn by hand",
    );
  });

  test("the boxes are drawn once each, on the Branch pane, at their share of the measured size", () => {
    mount(measured);
    expect(host.querySelectorAll('[data-testid="gap-box"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="special-box"]')).toHaveLength(1);
    expect(gapBox()?.getAttribute("title")).toBe(
      "#go: extra classes on a Hack Cove UI component: mt-7",
    );
    // 10 of 40 px in from the left and 10 wide: a quarter and a quarter.
    expect(gapBox()?.style.left).toBe("25%");
    expect(gapBox()?.style.width).toBe("25%");
    expect(gapBox()?.style.top).toBe("25%");
    expect(specialBox()?.style.top).toBe("50%");
    // Only the Branch pane carries them.
    const figure = gapBox()?.closest("figure");
    expect(figure?.textContent).toContain("Branch");
    expect(host.querySelectorAll("figure")).toHaveLength(2);
    expect(host.querySelectorAll("figure [data-testid='gap-box']")).toHaveLength(1);
  });

  test("a new shot, which nothing measured, has its boxes placed on the image's own size", () => {
    mount(null);
    // Nothing measured it, so no box can be placed until the image says how big it is.
    expect(gapBox()).toBeNull();
    const img = host.querySelector<HTMLImageElement>('img[src="/branch.png"]');
    expect(img).not.toBeNull();
    Object.defineProperty(img, "naturalWidth", { value: 40 });
    Object.defineProperty(img, "naturalHeight", { value: 40 });
    act(() => {
      img?.dispatchEvent(new Event("load"));
    });
    expect(host.querySelectorAll('[data-testid="gap-box"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="special-box"]')).toHaveLength(1);
    expect(gapBox()?.style.left).toBe("25%");
  });

  test("hovering a box lights its row, and hovering a row lights its box", () => {
    mount(measured);
    expect(gapRow().hasAttribute("data-focused")).toBe(false);
    pointer(must(gapBox()), "enter");
    expect(gapRow().getAttribute("data-focused")).toBe("true");
    pointer(must(gapBox()), "leave");
    expect(gapRow().hasAttribute("data-focused")).toBe(false);

    const idle = gapBox()?.style.zIndex;
    pointer(gapRow(), "enter");
    expect(gapBox()?.style.zIndex).toBe("1");
    expect(idle).not.toBe("1");
    pointer(gapRow(), "leave");
    expect(gapBox()?.style.zIndex).not.toBe("1");
  });

  test("the boxes have their own toggle, and a legend that counts both kinds while they are drawn", () => {
    mount(measured);
    expect(legend()?.textContent).toContain("Not from Hack Cove UI");
    expect(legend()?.textContent).toContain("Special case");
    expect(legend()?.textContent?.replace(/\D/g, "")).toBe("11");
    act(() => toggle()?.click());
    expect(gapBox()).toBeNull();
    expect(specialBox()).toBeNull();
    expect(legend()).toBeNull();
    act(() => toggle()?.click());
    expect(gapBox()).not.toBeNull();
    expect(legend()).not.toBeNull();
  });
});

describe("the build page's card for a composition shot", () => {
  test("counts the gaps, and the special cases when there are any", () => {
    expect(findingsLine(composition)).toBe("1 gap not from Hack Cove UI · 1 special");
    expect(findingsLine({ ...composition, special: [] })).toBe("1 gap not from Hack Cove UI");
    expect(findingsLine({ ...composition, gaps: [...composition.gaps, ...composition.gaps] })).toBe(
      "2 gaps not from Hack Cove UI · 1 special",
    );
  });
});
