import { Field, Input } from "@hackcove/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ActionButton } from "./action-button";

/** The field's value and its in-flight state; `send` is the form's submit handler. */
function useFieldSubmit(onSubmit: (value: string) => Promise<unknown>, onClose: () => void) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = value.trim().length === 0;
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (empty || busy) return;
    setError(null);
    setBusy(true);
    void onSubmit(value.trim()).then(onClose, (e: unknown) => {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  return { value, setValue, busy, error, empty, send };
}

/**
 * A modal with one text field, for New project, New organization and Invite. The browser's own
 * <dialog> does the modal work: the page behind is inert, Esc closes it, focus stays inside. It is
 * only rendered while open, so it is always on a hydrated page and the field can take focus.
 */
export function FieldDialog({
  title,
  description,
  label,
  inputLabel,
  placeholder,
  hint,
  emptyReason,
  submit,
  busyLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  /** The visible label above the field. */
  label: string;
  /** The field's accessible name, when it says more than the visible label. */
  inputLabel: string;
  placeholder: string;
  hint: string;
  /** Said when the field is empty and the button is grey. */
  emptyReason: string;
  submit: string;
  busyLabel: string;
  /** Gets the trimmed value. Resolving closes the dialog; a rejection shows its message in it. */
  onSubmit: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inputId = useId();
  const { value, setValue, busy, error, empty, send } = useFieldSubmit(onSubmit, onClose);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${inputId}-title`}
      onClose={onClose}
      // A click on the scrim is a click on the <dialog> element itself, not on its contents.
      onClick={(event) => event.target === dialog.current && dialog.current?.close()}
      className="mx-auto mt-28 w-110 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-(--ps-scrim)"
    >
      <form onSubmit={send} className="p-5.5">
        <h2 id={`${inputId}-title`} className="text-[17px] font-semibold">
          {title}
        </h2>
        {description && <p className="mt-1 text-[13px] text-slate-600">{description}</p>}
        <Field
          label={label}
          htmlFor={inputId}
          hint={empty ? emptyReason : hint}
          error={error ?? undefined}
          className="mt-4"
        >
          <Input
            autoFocus
            id={inputId}
            aria-label={inputLabel}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <ActionButton variant="ghost" onClick={() => dialog.current?.close()}>
            Cancel
          </ActionButton>
          <ActionButton
            type="submit"
            disabledReason={empty ? emptyReason : undefined}
            busy={busy}
            busyLabel={busyLabel}
          >
            {submit}
          </ActionButton>
        </div>
      </form>
    </dialog>
  );
}
