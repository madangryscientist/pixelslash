/** A request the client got wrong: surfaces as a 400 with this message. */
export class BadRequest extends Error {}

/** Refuse the request: `<where> <what>` as a 400. */
export function bad(where: string, what: string): never {
  throw new BadRequest(`${where} ${what}`);
}

/** The actor may reach the row but not do this to it (a CI token resolving a flake): a 403. */
export class Forbidden extends Error {}

/** A request the server understood but will not take (a brief over its limit): a 422. */
export class Unprocessable extends Error {}
