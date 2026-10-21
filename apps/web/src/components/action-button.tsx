import { Button } from "@hackcove/ui";
import type { ComponentPropsWithoutRef } from "react";

type Props = Omit<ComponentPropsWithoutRef<typeof Button>, "disabled"> & {
  /** Why the button cannot be pressed right now. A string makes it grey and not-allowed; absent, it is live. */
  disabledReason?: string | undefined;
  /** The work is in flight: the label becomes `busyLabel` and the button keeps its colour. */
  busy?: boolean;
  busyLabel?: string;
  /** Disabled for a reason the user cannot act on (the page is not hydrated yet), so no grey. */
  waiting?: boolean;
};

const BLOCKED =
  "disabled:pointer-events-auto! disabled:cursor-not-allowed disabled:border-(--ps-dis-line)! disabled:bg-(--ps-dis-bg)! disabled:text-(--ps-dis-ink)! disabled:opacity-100!";
const BUSY = "disabled:pointer-events-auto! disabled:cursor-progress disabled:opacity-85!";

function stateOf(props: {
  disabledReason?: string | undefined;
  busy?: boolean | undefined;
  waiting?: boolean | undefined;
}) {
  const busy = props.busy === true;
  const blocked = props.disabledReason !== undefined && !busy;
  let style = "";
  if (blocked) style = BLOCKED;
  else if (busy) style = BUSY;
  return { busy, blocked, style, disabled: blocked || busy || props.waiting === true };
}

/**
 * @hackcove/ui's Button washes a disabled button out to half opacity, which reads as broken. Here a
 * button that is blocked goes flat grey with a not-allowed cursor, and the caller says why (the
 * reason is the `title`, and the caller shows it as text too: a disabled button shows no tooltip
 * to a keyboard or a phone). A busy one only changes its label. The `!` beats the Button's own
 * disabled classes, which are the same specificity and cannot be merged out.
 */
export function ActionButton({
  disabledReason,
  busy,
  busyLabel,
  waiting,
  className,
  children,
  title,
  ...rest
}: Props) {
  const state = stateOf({ disabledReason, busy, waiting });
  return (
    <Button
      {...rest}
      disabled={state.disabled}
      aria-busy={state.busy || undefined}
      title={state.blocked ? disabledReason : title}
      className={[state.style, className].filter(Boolean).join(" ")}
    >
      {state.busy && busyLabel ? busyLabel : children}
    </Button>
  );
}
