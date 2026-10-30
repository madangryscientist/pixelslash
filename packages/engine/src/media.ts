import type { Route, Variant } from "./config.ts";
import { mediaKey, type MediaBox } from "./page-areas.ts";

/**
 * What capture says about the media on a page (PS-230): the element, its rect and the edit that
 * fixes it. A story's route is not in the config, so it is told to mark the element in the story.
 */
export function mediaWarning(route: Route, variant: Variant, m: MediaBox): string {
  const fix = route.storybook
    ? "mark it with data-pixelslash-ignore in the story"
    : "add an exclusion zone (route.ignore) for this shot";
  return `warning: <${m.tag}> at ${m.x},${m.y} ${m.width}x${m.height} on ${route.name} (${variant.name}) — media renders unreliably; ${fix}`;
}

/**
 * Warn about each medium of a shot once per route, variant and rect: a flake check or an upload
 * captures the same shot again, and the second time has nothing new to say.
 */
export function mediaWarner(warn: (message: string) => void) {
  const warned = new Set<string>();
  return (route: Route, variant: Variant, media: MediaBox[]) => {
    for (const m of media) {
      const key = `${route.name}\0${variant.name}\0${mediaKey(m)}`;
      if (warned.has(key)) continue;
      warned.add(key);
      warn(mediaWarning(route, variant, m));
    }
  };
}
