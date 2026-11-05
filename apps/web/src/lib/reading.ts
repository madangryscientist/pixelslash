/** A figure that was read, or the reason it could not be: "unavailable" is never a number. */
export type Reading<T> = { ok: true; value: T } | { ok: false; why: string };

export const ok = <T>(value: T): Reading<T> => ({ ok: true, value });
export const unavailable = <T>(why: string): Reading<T> => ({ ok: false, why });
