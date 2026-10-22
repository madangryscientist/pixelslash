import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Body, Input, SectionHeading } from "@hackcove/ui";
import { ActionButton } from "#/components/action-button";
import type { ProjectModelView } from "#/db/models";
import { removeProjectModel, saveProjectModel } from "#/server/model";

/** The documented example; any OpenAI-compatible endpoint works. */
const EXAMPLE = { baseUrl: "https://api.deepseek.com", model: "deepseek-flash" };

/**
 * The project's own vision model (ob 1473): each changed region of a branch build is sent to it as
 * three crops, and its label and sentence are shown with the region. The key is write-only: once
 * saved, the page shows that one is set, never the key.
 */
export function ModelSettings({
  projectId,
  saved,
  hydrated,
}: {
  projectId: string;
  saved: ProjectModelView | null;
  hydrated: boolean;
}) {
  const router = useRouter();
  const [fields, setFields] = useState<Fields>({
    baseUrl: saved?.baseUrl ?? "",
    model: saved?.model ?? "",
    apiKey: "",
    autoPassNoise: saved?.autoPassNoise ?? false,
  });
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (which: "save" | "remove", work: () => Promise<unknown>) => {
    setError(null);
    setBusy(which);
    try {
      await work();
      setFields((f) => ({ ...f, apiKey: "" }));
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run("save", () => saveProjectModel({ data: { projectId, ...fields } }));
  };
  const remove = () => void run("remove", () => removeProjectModel({ data: { projectId } }));

  return (
    <section
      className="mt-6 rounded-xl border border-slate-200 bg-white p-6"
      data-testid="model-settings"
    >
      <SectionHeading className="mb-1.5">AI explanations</SectionHeading>
      <Body as="p" className="mb-4">
        Any OpenAI-compatible vision endpoint. For each changed region of a branch build, the server
        sends that region&apos;s baseline, new and diff crops to this model only, and shows its
        label (intended, unintended or noise) and one sentence next to the region. With no model, or
        when a call fails, the shot is reviewed as plain pixels. Nothing is sent until this is
        saved.
      </Body>
      <form onSubmit={save} className="grid gap-3 text-sm sm:grid-cols-2">
        <ModelFields fields={fields} setFields={setFields} keySet={!!saved} hydrated={hydrated} />
        <ModelActions
          fields={fields}
          saved={saved}
          busy={busy}
          hydrated={hydrated}
          onRemove={remove}
        />
        {error && (
          <p role="alert" className="text-sm text-red-700 sm:col-span-2">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

type Fields = { baseUrl: string; model: string; apiKey: string; autoPassNoise: boolean };

function ModelFields({
  fields,
  setFields,
  keySet,
  hydrated,
}: {
  fields: Fields;
  setFields: (update: (f: Fields) => Fields) => void;
  keySet: boolean;
  hydrated: boolean;
}) {
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));
  return (
    <>
      <label className="block">
        <span className="text-slate-700">Base URL</span>
        <Input
          value={fields.baseUrl}
          placeholder={EXAMPLE.baseUrl}
          disabled={!hydrated}
          onChange={(e) => set({ baseUrl: e.target.value })}
          data-testid="model-base-url"
          className="mt-0.5 w-full px-3"
        />
      </label>
      <label className="block">
        <span className="text-slate-700">Model</span>
        <Input
          value={fields.model}
          placeholder={EXAMPLE.model}
          disabled={!hydrated}
          onChange={(e) => set({ model: e.target.value })}
          data-testid="model-name"
          className="mt-0.5 w-full px-3"
        />
      </label>
      <label className="block sm:col-span-2">
        <span className="text-slate-700">API key</span>
        <Input
          type="password"
          autoComplete="off"
          value={fields.apiKey}
          placeholder={keySet ? "key set: leave empty to keep it" : "sk-…"}
          disabled={!hydrated}
          onChange={(e) => set({ apiKey: e.target.value })}
          data-testid="model-key"
          className="mt-0.5 w-full px-3"
        />
        <span className="block text-xs text-slate-500">
          Stored for this project and never shown again. A new base URL needs its key again.
        </span>
      </label>
      <label className="flex items-start gap-2 sm:col-span-2">
        <input
          type="checkbox"
          checked={fields.autoPassNoise}
          disabled={!hydrated}
          onChange={(e) => set({ autoPassNoise: e.target.checked })}
          data-testid="model-auto-pass"
          className="mt-1"
        />
        <span>
          <span className="font-medium">Auto-pass noise</span>
          <span className="block text-slate-600">
            Accept a shot when the model labels every changed region noise. Off, noise is only
            labelled and a person still decides.
          </span>
        </span>
      </label>
    </>
  );
}

function ModelActions({
  fields,
  saved,
  busy,
  hydrated,
  onRemove,
}: {
  fields: Fields;
  saved: ProjectModelView | null;
  busy: "save" | "remove" | null;
  hydrated: boolean;
  onRemove: () => void;
}) {
  const missing =
    !fields.baseUrl.trim() || !fields.model.trim() || (!saved && !fields.apiKey.trim());
  return (
    <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
      <ActionButton
        type="submit"
        waiting={!hydrated}
        disabledReason={missing ? "Give the base URL, the model and the key." : undefined}
        busy={busy === "save"}
        busyLabel="Saving…"
        data-testid="model-save"
      >
        Save model
      </ActionButton>
      {saved && (
        <>
          <ActionButton
            type="button"
            variant="ghost"
            waiting={!hydrated}
            busy={busy === "remove"}
            busyLabel="Removing…"
            onClick={onRemove}
            className="text-red-700!"
            data-testid="model-remove"
          >
            Remove model and key
          </ActionButton>
          <span className="text-xs text-slate-500" data-testid="model-key-set">
            Key set for {saved.baseUrl}
          </span>
        </>
      )}
    </div>
  );
}
