import { createServerFn } from "@tanstack/react-start";
import { flagSnapshot, withdrawFlag } from "#/db/flags";
import { FLAG_KINDS, type FlagKind, type IgnoreRect } from "#/db/schema";
import { BadRequest, parseRect } from "#/api/validate";
import { database } from "./env";
import { field, noteInput, or404 } from "./input";
import { requireViewer } from "./session";

/* ------------------------------------------------------------ detection flags (ob 1721) */

const isFlagKind = (v: unknown): v is FlagKind => FLAG_KINDS.some((kind) => kind === v);

/** The flag's kind, its optional one-line note and its optional rect, from a server-fn payload. */
function flagInput(d: unknown): { kind: FlagKind; note: string | null; rect: IgnoreRect | null } {
  const get = (key: string) => (typeof d === "object" && d !== null ? Reflect.get(d, key) : null);
  const kind = get("kind");
  if (!isFlagKind(kind)) throw new Error(`kind is one of ${FLAG_KINDS.join(", ")}`);
  const note = noteInput(d);
  const rect = get("rect");
  try {
    return { kind, note, rect: rect == null ? null : parseRect(rect, "rect") };
  } catch (error) {
    // A server fn has no 400: the message is what the form shows.
    if (error instanceof BadRequest) throw new Error(error.message, { cause: error });
    throw error;
  }
}

/** Create or replace the viewer's flag on a shot. It decides nothing: review state is untouched. */
export const flagShot = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    snapshotId: field(d, "snapshotId"),
    ...flagInput(d),
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(flagSnapshot(database(), { ...data, userId: user.id }));
  });

export const withdrawShotFlag = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    snapshotId: field(d, "snapshotId"),
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(withdrawFlag(database(), { ...data, userId: user.id }));
  });
