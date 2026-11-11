import { useSyncExternalStore } from "react";

/** Tailwind's `lg`: from here the review page puts its side panel beside the image, not under it. */
const QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void) {
  const media = matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * True when the screen is `lg` wide or more. False in the server render and while React hydrates,
 * so the page is first drawn as it is on a phone (nothing hidden) and narrows itself once live.
 */
export function useWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(QUERY).matches,
    () => false,
  );
}
