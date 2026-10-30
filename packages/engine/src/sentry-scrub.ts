/**
 * What an error report may carry (PS-227). One `beforeSend` for the three places that report: the
 * server, the browser and the CLI. It keeps the message, the stack, the release and the
 * environment, and drops everything that could hold a person's data: request bodies, cookies,
 * the request's query string, auth headers, the user, breadcrumbs, and any token or image bytes that found
 * their way into a string. It is a deny-by-default walk of the whole event, so a field the SDK adds
 * later is scrubbed too. A shot never reaches Sentry (invariant 4); this is the second lock on
 * that door, the first being that nothing here ever attaches one.
 *
 * Pure and dependency-free: it runs in workerd, in a browser and under Bun.
 */

const REDACTED = "[redacted]";

/** Headers worth keeping; every other request header is dropped, not matched against a deny list. */
const KEEP_HEADERS = new Set(["user-agent", "content-type", "content-length", "accept", "host"]);

/** A key whose value is never sent, whatever it holds. */
const SECRET_KEY =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|signature|session|dsn|bearer|^sig$/i;

/** A data URL, or a PNG (base64 from its signature on, or raw from its magic byte on), anywhere in a string. */
const IMAGE_DATA =
  /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+|iVBORw0KGgo[A-Za-z0-9+/=_-]*|\u0089PNG[\s\S]*/g;
/** A run of base64 too long to be anything but a blob. */
const BLOB_RUN = /[A-Za-z0-9+/_-]{200,}={0,2}/g;
/** The tokens this product issues or accepts: upload (`psu_`, `psci_`, `psorg_`), Figma, model and GitHub keys. */
const TOKEN =
  /\b(?:psu_|psci_|psorg_|pst_|figd_|sk-|ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_-]{6,}|\bBearer\s+\S+/g;
/** A secret in a URL: a signed image link's `sig`, an OAuth `code`, an access token. */
const URL_SECRET = /([?&](?:sig|signature|token|access_token|code|state|key|secret)=)[^&\s"'#]*/gi;

function scrubString(value: string): string {
  return value
    .replace(IMAGE_DATA, "[image data]")
    .replace(TOKEN, REDACTED)
    .replace(URL_SECRET, `$1${REDACTED}`)
    .replace(BLOB_RUN, "[blob data]");
}

function isBinary(value: object): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob;
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (isBinary(value)) return "[binary data]";
  if (depth > 12) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : scrubValue(inner, depth + 1);
  }
  return out;
}

/** The URL without its query string or fragment: `?sig=…` and `?code=…` are secrets. */
function bareUrl(url: unknown): unknown {
  if (typeof url !== "string") return url;
  return scrubString(url.replace(/[?#].*$/, ""));
}

function scrubRequest(request: unknown): unknown {
  if (request === null || typeof request !== "object") return request;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (key === "url") kept["url"] = bareUrl(value);
    else if (key === "method") kept["method"] = value;
    else if (key === "headers" && value !== null && typeof value === "object") {
      kept["headers"] = Object.fromEntries(
        Object.entries(value).filter(([name]) => KEEP_HEADERS.has(name.toLowerCase())),
      );
    }
    // `data` (the body), `cookies`, `query_string` and `env` are dropped, not scrubbed.
  }
  return kept;
}

/**
 * The event as it may leave the machine. Use as `beforeSend`. Scrubs the event in place and never
 * returns null: an error is still worth reporting once what is private about it is gone.
 */
export function scrubEvent<T extends object>(event: T): T {
  const scrubbed = scrubValue(event, 0);
  if (scrubbed === null || typeof scrubbed !== "object") return event;
  for (const key of Object.keys(event)) {
    if (key === "breadcrumbs" || key === "user") Reflect.deleteProperty(event, key);
    else Reflect.set(event, key, Reflect.get(scrubbed, key));
  }
  // `request` goes through its own allowlist before the walk's: headers are kept by name, not by luck.
  const request = Reflect.get(event, "request");
  if (request !== undefined) Reflect.set(event, "request", scrubRequest(request));
  return event;
}
