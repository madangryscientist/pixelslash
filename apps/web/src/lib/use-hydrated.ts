import { useSyncExternalStore } from "react";

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
