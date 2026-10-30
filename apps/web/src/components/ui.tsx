import { AppShell, Button, Caption, Cluster, Input, Pill, Stack, Text } from "@hackcove/ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { useHydrated } from "#/lib/use-hydrated";
import { AppBrand, AppControls } from "./shell";

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
    <Pill dot tone={tone[status] ?? "slate"} data-testid="build-status">
      {status}
    </Pill>
  );
}

/** One review state or decision, e.g. `accepted by ada`. */
export function ReviewChip({ state, by }: { state: string; by?: string | null }) {
  const tone: Record<string, Tone> = { pending: "slate", accepted: "emerald", rejected: "red" };
  return (
    <Pill tone={tone[state] ?? "slate"} data-testid="review-state">
      {by ? `${state} by ${by}` : state}
    </Pill>
  );
}

/**
 * The page frame. `data-hydrated` is false in the server HTML and true once React owns the page.
 * The controls disable themselves until then, and a browser test can wait for the same signal.
 * The page's layout (`ListLayout`, `SidebarLayout`, ...) goes inside; only `FullBleedLayout`
 * draws its own edge and needs `bleed`.
 */
export function Page({ bleed = false, children }: { bleed?: boolean; children: ReactNode }) {
  const hydrated = useHydrated();
  return (
    <AppShell
      brand={<AppBrand />}
      controls={<AppControls />}
      bleed={bleed}
      data-hydrated={hydrated}
    >
      {children}
    </AppShell>
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
    <Stack as="form" gap="xs" onSubmit={submit}>
      <Cluster gap="sm">
        <Input
          aria-label={label}
          placeholder={label}
          value={value}
          disabled={!hydrated}
          onChange={(e) => setValue(e.target.value)}
          width="lg"
        />
        <Button
          type="submit"
          disabled={!hydrated}
          disabledReason={empty ? emptyReason : undefined}
          busy={busy}
          busyLabel={busyLabel}
        >
          {button}
        </Button>
      </Cluster>
      {error ? (
        <Text as="p" role="alert" tone="danger">
          {error}
        </Text>
      ) : (
        empty && hydrated && <Caption as="p">{emptyReason}</Caption>
      )}
    </Stack>
  );
}
