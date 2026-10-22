import { Input, PageHeading, Pill } from "@hackcove/ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { useHydrated } from "#/lib/use-hydrated";
import { ActionButton } from "./action-button";
import { AppHeader } from "./shell";

export { useHydrated };

type Tone = "slate" | "amber" | "emerald" | "blue" | "red";

/** A build's verdict, in the colours a reviewer reads first. */
export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, Tone> = {
    changes: "amber",
    passed: "emerald",
    failed: "red",
    errored: "red",
    processing: "blue",
    uploading: "slate",
  };
  return (
    <span data-testid="build-status">
      <Pill dot tone={tone[status] ?? "slate"}>
        {status}
      </Pill>
    </span>
  );
}

/** One review state or decision, e.g. `accepted by ada`. */
export function ReviewChip({ state, by }: { state: string; by?: string | null }) {
  const tone: Record<string, Tone> = { pending: "slate", accepted: "emerald", rejected: "red" };
  return (
    <span data-testid="review-state">
      <Pill tone={tone[state] ?? "slate"}>{by ? `${state} by ${by}` : state}</Pill>
    </span>
  );
}

/**
 * `data-hydrated` is false in the server HTML and true once React owns the page. The controls
 * disable themselves until then, and a browser test can wait for the same signal. `crumbs` are
 * the links above this page (org, project, build), shown in the header before its own title.
 */
export function Page({
  title,
  wide = false,
  full = false,
  crumbs,
  children,
}: {
  title: string;
  wide?: boolean;
  /** Edge to edge with no page heading: the page draws its own (the organizations page). */
  full?: boolean;
  crumbs?: ReactNode[];
  children: ReactNode;
}) {
  const hydrated = useHydrated();
  return (
    <div className="app-canvas min-h-screen" data-hydrated={hydrated}>
      <AppHeader crumbs={crumbs} wide={wide} full={full} />
      {full ? (
        <main>{children}</main>
      ) : (
        <main className={`mx-auto px-6 py-8 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
          <PageHeading className="mb-6">{title}</PageHeading>
          {children}
        </main>
      )}
    </div>
  );
}

/**
 * One text field and a button. `onSubmit` gets the trimmed value; the field clears on
 * success and shows the error on failure.
 */
export function InlineForm({
  label,
  button,
  busyLabel,
  emptyReason,
  initialValue,
  onSubmit,
}: {
  label: string;
  button: string;
  busyLabel: string;
  /** Why the button is grey while the field is empty: its `title` and the line under the field. */
  emptyReason: string;
  /** A field that edits a stored value starts at it and keeps what was saved; one that adds a thing starts empty and clears. */
  initialValue?: string;
  onSubmit: (value: string) => Promise<unknown>;
}) {
  const hydrated = useHydrated();
  const [value, setValue] = useState(initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = value.trim().length === 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (empty) return;
    setError(null);
    setBusy(true);
    onSubmit(value.trim())
      .then(
        () => setValue(initialValue === undefined ? "" : value.trim()),
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={label}
        placeholder={label}
        value={value}
        disabled={!hydrated}
        onChange={(e) => setValue(e.target.value)}
        className="min-w-0 flex-1 px-3"
      />
      <ActionButton
        type="submit"
        waiting={!hydrated}
        disabledReason={empty ? emptyReason : undefined}
        busy={busy}
        busyLabel={busyLabel}
      >
        {button}
      </ActionButton>
      {error ? (
        <p role="alert" className="w-full text-sm text-red-700">
          {error}
        </p>
      ) : (
        empty && hydrated && <p className="w-full text-xs text-slate-400">{emptyReason}</p>
      )}
    </form>
  );
}
