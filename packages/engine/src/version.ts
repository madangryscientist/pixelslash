/**
 * The client's version, sent as `User-Agent: pixelslash/<version>` on every API request (ob 1729),
 * so a server can refuse a CLI older than it takes with `426 cli_outdated`. Bump it with a release.
 */
export const CLIENT_VERSION = "0.1.0";

export const USER_AGENT = `pixelslash/${CLIENT_VERSION}`;
