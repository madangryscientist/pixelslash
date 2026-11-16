import { BadRequest } from "./errors";

/** The request's JSON body; a body that is not JSON is a 400. */
export async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
}
