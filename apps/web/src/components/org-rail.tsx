import { Link } from "@tanstack/react-router";
import type { OrgOverview } from "#/db/orgs";
import { colourOf } from "./avatar";
import { ActionButton } from "./action-button";

/**
 * The organizations down the left, each with how many of its projects have a latest build waiting
 * on a decision. The badge is amber when there is work and a plain grey count when there is not.
 */
export function OrgRail({
  orgs,
  selectedId,
  onNew,
  hydrated,
}: {
  orgs: OrgOverview[];
  selectedId: string | null;
  onNew: () => void;
  hydrated: boolean;
}) {
  return (
    <aside className="border-b border-slate-200 bg-white px-3 py-5 md:border-r md:border-b-0">
      <h2 className="mx-2.5 mb-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
        Organizations
      </h2>
      <nav aria-label="Organizations">
        <ul className="space-y-0.5">
          {orgs.map((org) => {
            const selected = org.id === selectedId;
            return (
              <li key={org.id}>
                <Link
                  to="/orgs"
                  search={{ org: org.id }}
                  data-testid="org-link"
                  aria-current={selected ? "page" : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 ${selected ? "bg-(--ps-brand-soft) font-semibold text-slate-900" : "text-slate-600 hover:bg-slate-50"}`}
                >
                  <span
                    aria-hidden="true"
                    style={{ background: colourOf(org.name) }}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs font-bold text-white"
                  >
                    {org.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{org.name}</span>
                  {org.waiting > 0 ? (
                    <span
                      title={`${org.waiting} ${org.waiting === 1 ? "project has" : "projects have"} shots to review`}
                      className="grid h-4.5 min-w-4.5 place-items-center rounded-full bg-(--ps-changed) px-1.5 text-[11px] font-bold text-(--ps-brand-ink)"
                    >
                      {org.waiting}
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-slate-400">0</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <ActionButton
        variant="ghost"
        waiting={!hydrated}
        onClick={onNew}
        className="mt-2.5 w-full justify-start border-0 px-2.5 text-[13px] font-normal"
      >
        <span
          aria-hidden="true"
          className="grid h-6 w-6 place-items-center rounded-md border border-dashed border-slate-300 text-slate-400"
        >
          +
        </span>
        New organization
      </ActionButton>
    </aside>
  );
}
