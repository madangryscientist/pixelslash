/**
 * Which hosts a project's or org's model may be (PS-250). The base URL is anyone's input, and the
 * server calls it, so a URL naming the server's own network (loopback, a private range, the cloud
 * metadata address) would let a stranger reach it from the server. Those are refused at save time
 * and again at call time, after the name is resolved, so a public name pointed at a private
 * address later is refused too. A self-host that runs its own model on its own network sets
 * `PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS=1`; the scheme check holds either way.
 */

export class ModelHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelHostError";
  }
}

/** A name's addresses. Anything in the answer that is not an IP (workerd lists CNAMEs) is ignored. */
export type HostResolver = (host: string) => Promise<string[]>;

/** `allowPrivate` is the server's `PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS`, never user input. */
export type ModelHostPolicy = { allowPrivate: boolean; resolve?: HostResolver | undefined };

/** Refused IPv4 ranges: [first octets as a number, prefix length, what it is]. */
const V4_REFUSED: [number, number, string][] = [
  [0x00000000, 8, "this-network"],
  [0x7f000000, 8, "loopback"],
  [0x0a000000, 8, "private (RFC 1918)"],
  [0xac100000, 12, "private (RFC 1918)"],
  [0xc0a80000, 16, "private (RFC 1918)"],
  [0xa9fe0000, 16, "link-local"],
  [0x64400000, 10, "CGNAT"],
];

function v4Number(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}

function refusedV4(n: number): string | null {
  for (const [base, bits, what] of V4_REFUSED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === base) return what;
  }
  return null;
}

const groupsOf = (half: string | undefined) => (half ? half.split(":") : []);

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().split("%")[0] ?? "";
  // A dotted IPv4 tail (`::ffff:10.0.0.1`) is two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const n = v4Number(tail[2] ?? "");
    if (n === null) return null;
    text = `${tail[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = groupsOf(halves[0]);
  const rest = groupsOf(halves[1]);
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill("0"), ...rest];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** Refused IPv6 ranges by their first group: [mask, value, what it is]. */
const V6_REFUSED: [number, number, string][] = [
  [0xfe00, 0xfc00, "private (unique local)"],
  [0xffc0, 0xfe80, "link-local"],
  [0xffc0, 0xfec0, "site-local"],
];

const allZero = (groups: number[]) => groups.every((v) => v === 0);

/** The IPv4 address an IPv6 one carries (mapped, compatible, NAT64, 6to4), or null. */
function embeddedV4(g: number[]): number | null {
  const at = (i: number) => g[i] ?? 0;
  const last = ((at(6) << 16) | at(7)) >>> 0;
  const mappedOrCompatible = allZero(g.slice(0, 5)) && (at(5) === 0xffff || at(5) === 0);
  if (mappedOrCompatible) return last; // ::ffff:a.b.c.d, ::a.b.c.d
  if (at(0) === 0x64 && at(1) === 0xff9b && allZero(g.slice(2, 6))) return last; // 64:ff9b::/96
  if (at(0) === 0x2002) return ((at(1) << 16) | at(2)) >>> 0; // 2002::/16
  return null;
}

function refusedV6(g: number[]): string | null {
  if (allZero(g.slice(0, 7)) && g[7] === 1) return "loopback";
  if (allZero(g)) return "unspecified";
  const first = g[0] ?? 0;
  const range = V6_REFUSED.find(([mask, value]) => (first & mask) === value);
  if (range) return range[2];
  // An IPv4 address carried inside IPv6 is judged as that IPv4 address.
  const v4 = embeddedV4(g);
  return v4 === null ? null : refusedV4(v4);
}

/** Why an IP address may not be a model host, or null when it may; null for a non-IP too. */
export function refusedAddress(ip: string): string | null {
  const bare = ip.replace(/^\[|\]$/g, "");
  const v4 = v4Number(bare);
  if (v4 !== null) return refusedV4(v4);
  const v6 = bare.includes(":") ? v6Groups(bare) : null;
  return v6 ? refusedV6(v6) : null;
}

export function isIpAddress(text: string): boolean {
  const bare = text.replace(/^\[|\]$/g, "");
  return v4Number(bare) !== null || (bare.includes(":") && v6Groups(bare) !== null);
}

/** Why a host name may not be a model host, or null: names that only mean something inside a network. */
function refusedName(host: string): string | null {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return "loopback";
  if (name.endsWith(".local")) return "a .local name";
  if (name.endsWith(".internal")) return "an .internal name";
  if (!name.includes(".")) return "a single-label name";
  return null;
}

/** The scheme and literal checks, with no lookup: the parsed URL, or ModelHostError. */
export function checkModelUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ModelHostError("base URL is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ModelHostError("base URL must be http or https");
  if (allowPrivate) return url;
  const host = url.hostname;
  const why = isIpAddress(host) ? refusedAddress(host) : refusedName(host);
  if (why) throw new ModelHostError(refusal(host, why));
  return url;
}

const refusal = (host: string, why: string) =>
  `base URL host ${host} is ${why}: a model must be on the public internet (a self-host may set PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS=1)`;

/**
 * The runtime's resolver: `node:dns` in Bun and Node, DNS over HTTPS in workerd. Null when the
 * runtime has none, so the check falls back to the literal checks rather than refusing every model.
 */
const systemResolver: HostResolver = async (host) => {
  const dns = await import("node:dns/promises");
  const found = await dns.lookup(host, { all: true });
  return found.map((a) => a.address);
};

function unsupported(e: unknown): boolean {
  const code = typeof e === "object" && e ? Reflect.get(e, "code") : null;
  return code === "ERR_NOT_IMPLEMENTED" || code === "ERR_MODULE_NOT_FOUND";
}

/**
 * The whole check: `checkModelUrl`, then every address the name resolves to. A name that does not
 * resolve is refused, as is one with any refused address among its answers.
 */
export async function checkModelHost(raw: string, policy: ModelHostPolicy): Promise<URL> {
  const url = checkModelUrl(raw, policy.allowPrivate);
  const host = url.hostname;
  if (policy.allowPrivate || isIpAddress(host)) return url;
  let answers: string[];
  try {
    answers = await (policy.resolve ?? systemResolver)(host);
  } catch (e) {
    if (!policy.resolve && unsupported(e)) return url;
    throw new ModelHostError(`base URL host ${host} does not resolve`);
  }
  const addresses = answers.filter(isIpAddress);
  if (addresses.length === 0) throw new ModelHostError(`base URL host ${host} does not resolve`);
  for (const address of addresses) {
    const why = refusedAddress(address);
    if (why) throw new ModelHostError(refusal(`${host} (${address})`, why));
  }
  return url;
}
