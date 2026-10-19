import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
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
      <main className="mx-auto max-w-3xl px-6 py-8">
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
        onChange={(e) => setValue(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        disabled={value.trim().length === 0}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      >
        {button}
      </button>
      {error && <p className="w-full text-sm text-red-700">{error}</p>}
    </form>
  );
}
