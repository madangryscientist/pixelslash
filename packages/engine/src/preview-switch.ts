/**
 * The in-page half of a reused Storybook preview page (PS-445). Every function here is serialized
 * and runs in the page, so none calls another: the init script hooks the preview's channel, and a
 * switch puts the page back as the preview booted it, then asks the channel for the next story.
 */

type Attrs = Record<string, string>;
type El = {
  attributes: ArrayLike<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};
type Kid = { remove(): void };
/** What the channel's events carry, as far as the hook reads them. */
type SbEvent = { storyId?: string; newPhase?: string; message?: string; title?: string };
type Channel = {
  on(event: string, listener: (e?: SbEvent) => void): void;
  emit(event: string, payload: object): void;
};
/** What the hook keeps on the page: the channel, each story's render phase, the last failure and the page as booted. */
type SbState = {
  channel?: Channel;
  phase: Record<string, string>;
  failed: string | null;
  pre: { html: Attrs; body: Attrs; kids: Set<Kid> } | null;
};

/**
 * Browser globals these touch (the tsconfig has no DOM lib). Type-only: the functions run in the
 * page, where these are the real globals.
 */
declare const window: { psSb?: SbState; scrollTo(x: number, y: number): void };
declare const document: {
  documentElement: El;
  body: El & { children: ArrayLike<Kid> };
  activeElement: { blur?: () => void } | null;
};

/**
 * Init script: record the preview channel's render phases and failures as they arrive. The channel
 * global is assigned once while the preview boots, so the setter hooks it then. The first phase
 * event is the first story starting: the page as the preview booted it, kept for the switch.
 */
export function hookChannel(): void {
  const st: SbState = { phase: {}, failed: null, pre: null };
  window.psSb = st;
  let held: Channel | undefined;
  Object.defineProperty(window, "__STORYBOOK_ADDONS_CHANNEL__", {
    configurable: true,
    get: () => held,
    set: (ch?: Channel) => {
      held = ch;
      if (typeof ch?.on !== "function") return;
      st.channel = ch;
      ch.on("storyRenderPhaseChanged", (e) => {
        st.pre ??= {
          html: Object.fromEntries(
            Array.from(document.documentElement.attributes, (a): [string, string] => [
              a.name,
              a.value,
            ]),
          ),
          body: Object.fromEntries(
            Array.from(document.body.attributes, (a): [string, string] => [a.name, a.value]),
          ),
          kids: new Set(Array.from(document.body.children)),
        };
        if (e?.storyId && e.newPhase) st.phase[e.storyId] = e.newPhase;
      });
      const fail = (e?: SbEvent) => {
        st.failed = (e?.message ?? e?.title ?? "").slice(0, 300) || "the story threw";
      };
      ch.on("storyThrewException", fail);
      ch.on("storyErrored", fail);
      ch.on("storyMissing", () => (st.failed = "the preview has no such story"));
    },
  });
}

/** Whether the page can be switched in place: the channel is hooked and the booted page was kept. */
export function previewHooked(): boolean {
  const st = window.psSb;
  return st?.channel !== undefined && st.pre !== null;
}

/**
 * Undo what the last story left outside the preview's own DOM: `<html>`'s and `<body>`'s attributes
 * (the body's class is the preview's), and anything added to `<body>` since it booted. The preview
 * unmounts its own root.
 */
export function resetPage(): void {
  const pre = window.psSb?.pre;
  if (!pre) return;
  const els: [El, Attrs, string][] = [
    [document.documentElement, pre.html, ""],
    [document.body, pre.body, "class"],
  ];
  for (const [el, was, keep] of els) {
    const added = Array.from(el.attributes).filter((a) => a.name !== keep && !(a.name in was));
    for (const { name } of added) el.removeAttribute(name);
    const changed = Object.entries(was).filter(([k, v]) => k !== keep && el.getAttribute(k) !== v);
    for (const [k, v] of changed) el.setAttribute(k, v);
  }
  for (const kid of Array.from(document.body.children)) if (!pre.kids.has(kid)) kid.remove();
}

/** Clear the focus, the scroll and the last story's state, then ask the preview for `id`. */
export function emitStory({ id }: { id: string }): void {
  const st = window.psSb;
  if (!st?.channel) throw new Error("the preview channel is not hooked");
  st.failed = null;
  delete st.phase[id];
  document.activeElement?.blur?.();
  window.scrollTo(0, 0);
  st.channel.emit("setCurrentStory", { storyId: id, viewMode: "story" });
}

/**
 * Where a switch to `want` is: `{ error }` once it failed, `{ error: null }` once it rendered, null
 * while it is still going. Under a paused clock the preview never leaves `completing` (its last step
 * waits on a timer), so `completing` counts as done: rendering and play are over.
 */
export function switchedState(want: string): { error: string | null } | null {
  const st = window.psSb;
  if (!st) return { error: "the preview page was reloaded" };
  const phase = st.phase[want];
  if (st.failed || phase === "errored") return { error: st.failed ?? "the story's render errored" };
  const done = ["completing", "completed", "afterEach", "finished"];
  return phase && done.includes(phase) ? { error: null } : null;
}
