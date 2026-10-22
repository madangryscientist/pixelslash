import { Body, SectionHeading } from "@hackcove/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ActionButton } from "#/components/action-button";
import { CopyButton } from "#/components/copy-button";
import type { DiffOptions } from "#/db/schema";
import { formatDateTime } from "#/lib/format";
import { clearDiffOverride } from "#/server/overrides";

/** Review-UI diff overrides (ob 1495) on the settings and build pages: the list, the audit trail. */

type Variant = { platform: string; browser: string; viewport: string; theme: string };

type Change = {
  id: string;
  name: string;
  variant: Variant | null;
  before: DiffOptions | null;
  after: DiffOptions | null;
  by: string;
  at: Date;
};

type Listed = {
  name: string;
  variant: Variant | null;
  options: DiffOptions;
  by: string;
  at: Date;
  snippet: string;
};

const HEAD = "py-2.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase";

const variantLabel = (v: Variant | null) =>
  v ? `${v.platform} · ${v.browser} · ${v.viewport} · ${v.theme}` : "every variant";

/** `threshold 0.1, minChangedPixels 100`; none is the config's values. */
function optionsText(options: DiffOptions | null): string {
  const entries = Object.entries(options ?? {});
  if (entries.length === 0) return "config";
  return entries.map(([k, v]) => `${k} ${v}`).join(", ");
}

/** Who changed what, when, from what to what: newest first. */
function OverrideChanges({ changes }: { changes: Change[] }) {
  if (changes.length === 0)
    return (
      <p data-testid="no-override-changes" className="text-sm text-slate-400">
        No thresholds were changed in the review screen.
      </p>
    );
  return (
    <table data-testid="override-changes" className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-slate-200">
          <th className={HEAD}>When</th>
          <th className={HEAD}>Who</th>
          <th className={HEAD}>Test</th>
          <th className={HEAD}>Change</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {changes.map((c) => (
          <tr key={c.id} data-testid="override-change">
            <td className="py-2 pr-3 whitespace-nowrap text-slate-600">{formatDateTime(c.at)}</td>
            <td className="pr-3">@{c.by}</td>
            <td className="pr-3">
              <span className="font-medium">{c.name}</span>
              <span className="block text-xs text-slate-500">{variantLabel(c.variant)}</span>
            </td>
            <td className="pr-3 font-mono text-[12px]">
              {optionsText(c.before)} → {optionsText(c.after)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A build page's trail: the threshold changes to its tests, or nothing when there are none. */
export function BuildOverrideChanges({ changes }: { changes: Change[] }) {
  if (changes.length === 0) return null;
  return (
    <section className="mt-6" data-testid="build-override-changes">
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        Thresholds changed in review
      </h2>
      <OverrideChanges changes={changes} />
    </section>
  );
}

function ClearButton({
  projectId,
  o,
  hydrated,
}: {
  projectId: string;
  o: Listed;
  hydrated: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clear = () => {
    setBusy(true);
    setError(null);
    clearDiffOverride({ data: { projectId, name: o.name, variant: o.variant } })
      .then(() => router.invalidate())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <ActionButton
        variant="ghost"
        waiting={!hydrated}
        busy={busy}
        busyLabel="Clearing…"
        onClick={clear}
        className="text-red-700!"
        data-testid="override-list-clear"
      >
        Clear
      </ActionButton>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </>
  );
}

/** The settings page's section: every override, clear one, export them all, and the trail. */
export function OverrideSettings({
  projectId,
  overrides,
  hydrated,
}: {
  projectId: string;
  overrides: { list: Listed[]; changes: Change[]; exported: string };
  hydrated: boolean;
}) {
  return (
    <section
      className="mt-6 rounded-xl border border-slate-200 bg-white p-6"
      data-testid="diff-overrides"
    >
      <SectionHeading className="mb-1.5">Diff thresholds set in review</SectionHeading>
      <Body as="p" className="mb-4">
        Set from a shot&apos;s screen, for a test or one variant of it; they beat the config&apos;s
        values. Clearing one applies the config&apos;s again from the next build.
      </Body>
      {overrides.list.length === 0 ? (
        <p data-testid="no-overrides" className="text-sm text-slate-400">
          None. Set one from a shot&apos;s screen.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={HEAD}>Test</th>
              <th className={HEAD}>Options</th>
              <th className={HEAD}>Set</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {overrides.list.map((o) => (
              <tr key={`${o.name}\n${variantLabel(o.variant)}`} data-testid="override-row">
                <td className="py-2 pr-3">
                  <span className="font-medium">{o.name}</span>
                  <span className="block text-xs text-slate-500">{variantLabel(o.variant)}</span>
                </td>
                <td className="pr-3 font-mono text-[12px]">{optionsText(o.options)}</td>
                <td className="pr-3 text-slate-600">
                  @{o.by}, {formatDateTime(o.at)}
                </td>
                <td className="text-right">
                  <CopyButton text={o.snippet} hydrated={hydrated} />
                  <ClearButton projectId={projectId} o={o} hydrated={hydrated} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {overrides.list.length > 0 && (
        <details className="mt-4 text-sm" data-testid="override-export">
          <summary className="cursor-pointer text-violet-700">Export as config</summary>
          <p className="mt-2 text-slate-600">
            Merge each route&apos;s <code>diff</code> and <code>variants</code> into the route of
            that name in <code>pixelslash.config.json</code>, then clear the overrides here: the
            builds measure the same. A key the config already sets on that variant beats a
            route&apos;s; move it to the variant.
          </p>
          <div className="mt-2 flex justify-end">
            <CopyButton text={overrides.exported} hydrated={hydrated} />
          </div>
          <pre
            data-testid="override-export-json"
            className="mt-1 overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[12px] text-slate-800"
          >
            {overrides.exported}
          </pre>
        </details>
      )}
      <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-700">Changes</h3>
      <OverrideChanges changes={overrides.changes} />
    </section>
  );
}
