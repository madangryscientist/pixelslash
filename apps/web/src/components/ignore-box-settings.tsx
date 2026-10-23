import { Body, SectionHeading } from "@hackcove/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ActionButton } from "#/components/action-button";
import { CopyButton } from "#/components/copy-button";
import { HEAD, type Variant, variantLabel } from "#/components/override-trail";
import type { IgnoreRect } from "#/db/schema";
import { formatDateTime } from "#/lib/format";
import { clearIgnoreBoxFromSettings } from "#/server/ignore-boxes";

/** Review-UI ignore boxes (ob 1499) on the settings page: the list, clear one, the audit trail. */

type Box = {
  id: string;
  name: string;
  variant: Variant | null;
  rect: IgnoreRect;
  by: string;
  at: Date;
  cleared: { by: string; at: Date } | null;
};

const rectText = (r: IgnoreRect) => `${r.width}×${r.height} at ${r.x},${r.y}`;

function ClearBox({
  projectId,
  boxId,
  hydrated,
}: {
  projectId: string;
  boxId: string;
  hydrated: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clear = () => {
    setBusy(true);
    setError(null);
    clearIgnoreBoxFromSettings({ data: { projectId, boxId } })
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
        data-testid="ignore-list-clear"
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

function TestCell({ box }: { box: Box }) {
  return (
    <td className="py-2 pr-3">
      <span className="font-medium">{box.name}</span>
      <span className="block text-xs text-slate-500">{variantLabel(box.variant)}</span>
    </td>
  );
}

/** Every box ever drawn, newest first: who drew it, and who cleared it. */
function BoxTrail({ trail }: { trail: Box[] }) {
  if (trail.length === 0)
    return (
      <p data-testid="no-ignore-trail" className="text-sm text-slate-400">
        No boxes were drawn in the review screen.
      </p>
    );
  return (
    <table data-testid="ignore-trail" className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-slate-200">
          <th className={HEAD}>Test</th>
          <th className={HEAD}>Box</th>
          <th className={HEAD}>Drawn</th>
          <th className={HEAD}>Cleared</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {trail.map((b) => (
          <tr key={b.id} data-testid="ignore-trail-row">
            <TestCell box={b} />
            <td className="pr-3 font-mono text-[12px]">{rectText(b.rect)}</td>
            <td className="pr-3 text-slate-600">
              @{b.by}, {formatDateTime(b.at)}
            </td>
            <td className="pr-3 text-slate-600">
              {b.cleared ? `@${b.cleared.by}, ${formatDateTime(b.cleared.at)}` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function IgnoreBoxSettings({
  projectId,
  boxes,
  trail,
  hydrated,
}: {
  projectId: string;
  boxes: (Box & { snippet: string })[];
  trail: Box[];
  hydrated: boolean;
}) {
  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-6"
      data-testid="ignore-box-settings"
    >
      <SectionHeading className="mb-1.5">Ignore boxes drawn in review</SectionHeading>
      <Body as="p" className="mb-4">
        Drawn on a shot&apos;s screen, for a test or one variant of it, in image px; the server diff
        skips them along with the config&apos;s and manifest&apos;s areas. The export above carries
        them. Clearing one measures those pixels again from the next build.
      </Body>
      {boxes.length === 0 ? (
        <p data-testid="no-ignore-boxes" className="text-sm text-slate-400">
          None. Draw one from a shot&apos;s screen.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={HEAD}>Test</th>
              <th className={HEAD}>Box</th>
              <th className={HEAD}>Drawn</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {boxes.map((b) => (
              <tr key={b.id} data-testid="ignore-row">
                <TestCell box={b} />
                <td className="pr-3 font-mono text-[12px]">{rectText(b.rect)}</td>
                <td className="pr-3 text-slate-600">
                  @{b.by}, {formatDateTime(b.at)}
                </td>
                <td className="text-right">
                  <CopyButton text={b.snippet} hydrated={hydrated} />
                  <ClearBox projectId={projectId} boxId={b.id} hydrated={hydrated} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-700">Trail</h3>
      <BoxTrail trail={trail} />
    </section>
  );
}
