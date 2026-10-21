/** Initials on a colour that is the same for the same name everywhere. */
const COLOURS = ["#7c3aed", "#f97316", "#06b6d4", "#10b981", "#0ea5e9", "#ec4899", "#d97706"];

export function colourOf(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length] ?? "#7c3aed";
}

export function initialsOf(login: string): string {
  return (
    login
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

/**
 * A person as a round badge. It never loads the GitHub avatar: that is a request to another
 * server for decoration, and it makes a screenshot depend on the network.
 */
export function Avatar({
  login,
  size = 26,
  ring = false,
}: {
  login: string;
  size?: number;
  /** A ring in the page colour, for a stack of overlapping avatars. */
  ring?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      title={login}
      style={{ width: size, height: size, background: colourOf(login), fontSize: size * 0.42 }}
      className={`inline-grid shrink-0 place-items-center rounded-full font-semibold text-white ${ring ? "-ml-1.5 border-2 border-slate-50 first:ml-0" : ""}`}
    >
      {initialsOf(login)}
    </span>
  );
}
