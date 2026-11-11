import type { Page } from "@playwright/test";

export type GroupRow = {
  top: number;
  /** Per group in the row: the card's bottom, the gap under its last link, and the group's width. */
  groups: { bottom: number; gap: number; width: number }[];
};

/** The /docs landing's groups, gathered by their top (within 2px) into the rows the grid laid out. */
export async function groupRows(page: Page): Promise<GroupRow[]> {
  return page
    .getByTestId("docs-index")
    .locator(":scope > li")
    .evaluateAll((items) => {
      const found: GroupRow[] = [];
      for (const item of items) {
        const card = item.querySelector(":scope > section");
        if (!card) throw new Error("a group has no card");
        const links = card.querySelectorAll("a");
        const last = links[links.length - 1];
        const bottom = card.getBoundingClientRect().bottom;
        const group = {
          bottom,
          gap:
            last === undefined
              ? Number.POSITIVE_INFINITY
              : bottom - last.getBoundingClientRect().bottom,
          width: item.getBoundingClientRect().width,
        };
        const top = item.getBoundingClientRect().top;
        const row = found.find((r) => Math.abs(r.top - top) <= 2);
        if (row) row.groups.push(group);
        else found.push({ top, groups: [group] });
      }
      return found;
    });
}
