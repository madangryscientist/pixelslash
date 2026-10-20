import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState, useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

/**
 * False in the server render and while React hydrates, true once this component is live.
 * The server renders every control, but a click or keystroke before hydration is lost: React
 * resets a controlled field to its empty state and never sees the event. Controls that
 * depend on React disable themselves until this is true.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

/** A build's verdict, in the colours a reviewer reads first. */
export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    changes: "bg-amber-100 text-amber-900",
    passed: "bg-emerald-100 text-emerald-900",
    failed: "bg-red-100 text-red-900",
    errored: "bg-red-100 text-red-900",
    processing: "bg-blue-100 text-blue-900",
    uploading: "bg-neutral-200 text-neutral-800",
  };
  return (
    <span
      data-testid="build-status"
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone[status] ?? "bg-neutral-200"}`}
    >
      {status}
    </span>
  );
}

/** One review state or decision, e.g. `accepted by ada`. */
export function ReviewChip({ state, by }: { state: string; by?: string | null }) {
  const tone: Record<string, string> = {
    pending: "bg-neutral-100 text-neutral-700",
    accepted: "bg-emerald-50 text-emerald-800",
    rejected: "bg-red-50 text-red-800",
  };
  return (
    <span
      data-testid="review-state"
      className={`rounded px-2 py-0.5 text-xs ${tone[state] ?? "bg-neutral-100"}`}
    >
      {by ? `${state} by ${by}` : state}
    </span>
  );
}

/**
 * `data-hydrated` is false in the server HTML and true once React owns the page. The controls
 * disable themselves until then, and a browser test can wait for the same signal.
 */
export function Page({
  title,
  wide = false,
  children,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const hydrated = useHydrated();
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900" data-hydrated={hydrated}>
      <header className="border-b border-neutral-200 bg-white">
        <div
          className={`mx-auto flex items-center justify-between px-6 py-3 ${wide ? "max-w-6xl" : "max-w-3xl"}`}
        >
          <Link to="/orgs" className="font-bold">
            PixelSlash
          </Link>
          <form method="post" action="/auth/sign-out">
            <button type="submit" className="text-sm text-neutral-600 hover:text-neutral-900">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className={`mx-auto px-6 py-8 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
        <h1 className="mb-6 text-2xl font-bold">{title}</h1>
        {children}
      </main>
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
  onSubmit,
}: {
  label: string;
  button: string;
  onSubmit: (value: string) => Promise<unknown>;
}) {
  const hydrated = useHydrated();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    onSubmit(value.trim()).then(
      () => setValue(""),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input
        aria-label={label}
        placeholder={label}
        value={value}
        disabled={!hydrated}
        onChange={(e) => setValue(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        disabled={!hydrated || value.trim().length === 0}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      >
        {button}
      </button>
      {error && <p className="w-full text-sm text-red-700">{error}</p>}
    </form>
  );
}
