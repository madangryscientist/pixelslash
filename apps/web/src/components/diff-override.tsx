import { Button, CodeBlock, Field, Input } from "@hackcove/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { CopyButton } from "#/components/copy-button";
import { useHydrated } from "#/components/ui";
import type { DiffOptions } from "#/db/schema";
import { formatDateTime } from "#/lib/format";
import { saveDiffOverride } from "#/server/overrides";

/**
 * Diff thresholds set from a shot's screen (ob 1495): for this test (every variant) or for this
 * test in this variant. Saving re-diffs the open build at once; later builds read it too. Each
 * override has its config snippet, so nothing set here is only here.
 */

const KEYS = ["threshold", "minChangedPixels", "minChangedRatio"] as const;
type Key = (typeof KEYS)[number];
type Scope = "test" | "variant";

const HINTS: Record<Key, string> = {
  threshold: "0–1: how different a pixel's colour must be to count",
  minChangedPixels: "changed pixels below this read as unchanged",
  minChangedRatio: "0–1: a changed share of the shot below this reads as unchanged",
};

type ShownOverride = {
  options: DiffOptions;
  by: string;
  at: Date;
  snippet: string;
};

type Draft = Record<Key, string>;

const draftOf = (o: ShownOverride | null): Draft => ({
  threshold: o?.options.threshold?.toString() ?? "",
  minChangedPixels: o?.options.minChangedPixels?.toString() ?? "",
  minChangedRatio: o?.options.minChangedRatio?.toString() ?? "",
});

/** The draft as options: an empty field is unset, so all-empty clears the override. */
function optionsOf(draft: Draft): DiffOptions {
  const out: DiffOptions = {};
  for (const key of KEYS) {
    const text = draft[key].trim();
    if (text !== "") out[key] = Number(text);
  }
  return out;
}

function noteOf(saved: {
  changed: boolean;
  rediffed: number;
  status: string;
  note: string | null;
}) {
  if (!saved.changed) return "Nothing changed.";
  if (saved.note) return saved.note;
  const shots = saved.rediffed === 1 ? "1 shot" : `${saved.rediffed} shots`;
  return `Saved. Re-diffed ${shots}; the build is ${saved.status}.`;
}

function useSave(ids: { projectId: string; buildId: string; snapshotId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const save = (scope: Scope, options: DiffOptions) => {
    setBusy(true);
    setError(null);
    setNote(null);
    saveDiffOverride({ data: { ...ids, scope, options } })
      .then((saved) => {
        setNote(noteOf(saved));
        return router.invalidate();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return { busy, error, note, save };
}

function OptionField({
  name,
  value,
  disabled,
  onChange,
}: {
  name: Key;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={name} htmlFor={`override-${name}-input`} hint={HINTS[name]}>
      <Input
        id={`override-${name}-input`}
        type="number"
        step="any"
        min="0"
        inputMode="decimal"
        placeholder="config's value"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`override-${name}`}
      />
    </Field>
  );
}

function Snippet({ o, hydrated }: { o: ShownOverride; hydrated: boolean }) {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          By @{o.by}, {formatDateTime(o.at)}. Copy as config:
        </span>
        <CopyButton text={o.snippet} hydrated={hydrated} />
      </div>
      <CodeBlock data-testid="override-snippet">{o.snippet}</CodeBlock>
    </div>
  );
}

export function DiffOverride({
  project,
  build,
  snapshot,
  overrides,
}: {
  project: { id: string; diffLocation: string };
  build: { id: string };
  snapshot: { id: string; diffStatus: string | null };
  overrides: { test: ShownOverride | null; variant: ShownOverride | null };
}) {
  // Held here, not in the form: a save remounts the form, and its note must outlive that.
  const saving = useSave({ projectId: project.id, buildId: build.id, snapshotId: snapshot.id });
  if (project.diffLocation !== "server" || snapshot.diffStatus === "removed") return null;
  return (
    // Keyed by the overrides held, so a save (or another reviewer's) resets the draft to them.
    <OverrideForm
      key={JSON.stringify([overrides.test?.options, overrides.variant?.options])}
      saving={saving}
      overrides={overrides}
    />
  );
}

function ScopePicker({ scope, onChange }: { scope: Scope; onChange: (scope: Scope) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="sr-only">Applies to</legend>
      {(["test", "variant"] as const).map((option) => (
        <label key={option} className="flex items-center gap-2">
          <input
            type="radio"
            name="override-scope"
            value={option}
            checked={scope === option}
            onChange={() => onChange(option)}
            data-testid={`override-scope-${option}`}
          />
          {option === "test" ? "This test" : "This test, this variant"}
        </label>
      ))}
    </fieldset>
  );
}

/** Save, and Clear when the scope holds an override. */
function Actions({
  waiting,
  busy,
  onClear,
}: {
  waiting: boolean;
  busy: boolean;
  onClear: (() => void) | null;
}) {
  return (
    <div className="flex gap-2">
      <Button
        type="submit"
        disabled={waiting}
        busy={busy}
        busyLabel="Saving…"
        size="sm"
        data-testid="override-save"
      >
        Save
      </Button>
      {onClear && (
        <Button
          type="button"
          variant="outline"
          disabled={waiting}
          busy={busy}
          busyLabel="Clearing…"
          onClick={onClear}
          size="sm"
          data-testid="override-clear"
        >
          Clear
        </Button>
      )}
    </div>
  );
}

function OverrideForm({
  saving,
  overrides,
}: {
  saving: ReturnType<typeof useSave>;
  overrides: { test: ShownOverride | null; variant: ShownOverride | null };
}) {
  const hydrated = useHydrated();
  const [scope, setScope] = useState<Scope>(overrides.variant ? "variant" : "test");
  const held = overrides[scope];
  const [drafts, setDrafts] = useState({
    test: draftOf(overrides.test),
    variant: draftOf(overrides.variant),
  });
  const draft = drafts[scope];
  const { busy, error, note, save } = saving;
  const set = (key: Key, value: string) =>
    setDrafts((d) => ({ ...d, [scope]: { ...d[scope], [key]: value } }));
  return (
    <section data-testid="diff-override">
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        Set thresholds
      </h2>
      <form
        className="space-y-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          save(scope, optionsOf(draft));
        }}
      >
        <ScopePicker scope={scope} onChange={setScope} />
        {KEYS.map((key) => (
          <OptionField
            key={key}
            name={key}
            value={draft[key]}
            disabled={!hydrated}
            onChange={(value) => set(key, value)}
          />
        ))}
        <p className="text-xs text-slate-500">
          Saving re-diffs this build now, and every later build reads it. Leave a field empty for
          the config's value.
        </p>
        <Actions waiting={!hydrated} busy={busy} onClear={held ? () => save(scope, {}) : null} />
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {note && (
        <p data-testid="override-note" className="mt-2 text-sm text-slate-600">
          {note}
        </p>
      )}
      {held && <Snippet o={held} hydrated={hydrated} />}
    </section>
  );
}
