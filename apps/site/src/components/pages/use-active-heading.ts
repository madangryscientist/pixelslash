import { useEffect, useState } from "react";

/** The id of the heading the reader is in: the last one whose top has passed the header, the first before any has. */
export function useActiveHeading(key: string, track: boolean): string | undefined {
  const [active, setActive] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!track) return undefined;
    // Heading ids are slugs, so `|` never occurs in one; `key` is how a new page is noticed.
    const ids = key.split("|");
    let frame = 0;
    const update = (): void => {
      frame = 0;
      // Where a heading anchor lands (its scroll-margin-top, styles.css), so the two never disagree.
      // Read on every update, so a resize that moves the header is picked up.
      const first = document.getElementById(ids[0] ?? "");
      const line = first ? Number.parseFloat(getComputedStyle(first).scrollMarginTop) + 1 : 0;
      let found: string | undefined = ids[0];
      for (const id of ids) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top === undefined) continue;
        if (top > line) break;
        found = id;
      }
      setActive(found);
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [key, track]);
  return active;
}
