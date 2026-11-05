import { useEffect } from "react";

const SCROLLERS = 'main [class*="overflow-x-auto"]';
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

/**
 * A code block or table wider than its box scrolls sideways, and a keyboard reader can only scroll
 * what can take focus. The UI kit's scrollers cannot, so each one that overflows and holds nothing
 * focusable gets a tab stop. Only those: a block that fits stays out of the tab order. This runs
 * again when the width or the page's content changes, which covers a lazy page that replaces its
 * server-rendered DOM after the shell has mounted.
 */
export function useKeyboardScrollers(): void {
  useEffect(() => {
    const mark = (): void => {
      for (const scroller of document.querySelectorAll<HTMLElement>(SCROLLERS)) {
        if (scroller.scrollWidth > scroller.clientWidth) {
          if (scroller.querySelector(FOCUSABLE) === null) scroller.tabIndex = 0;
        } else {
          scroller.removeAttribute("tabindex");
        }
      }
    };
    mark();
    const content = new MutationObserver(mark);
    content.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", mark);
    return () => {
      content.disconnect();
      window.removeEventListener("resize", mark);
    };
  }, []);
}
