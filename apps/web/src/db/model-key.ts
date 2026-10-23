/**
 * A project's model API key at rest (ob 1786): AES-256-GCM under `MODEL_KEY_SECRET` (base64 of 32
 * bytes), stored as `v1:<iv b64>:<ciphertext b64>`. A value without the `v1:` prefix is a key stored
 * before this existed, read as plain text and sealed the next time the project's model is saved.
 * No message here carries the key, the secret, or a stored value.
 */

const PREFIX = "v1:";
const IV_BYTES = 12;

/** The secret is missing or unusable. A deployment sets it with `wrangler secret put`. */
export class ModelKeySecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelKeySecretError";
  }
}

/** A stored key that this secret cannot open: a wrong secret, or a value that was altered. */
export class ModelKeyUnreadableError extends Error {
  constructor() {
    super("the stored model key cannot be decrypted with this MODEL_KEY_SECRET");
    this.name = "ModelKeyUnreadableError";
  }
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function importSecret(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new ModelKeySecretError("MODEL_KEY_SECRET is not set");
  let raw: Uint8Array<ArrayBuffer> | null = null;
  try {
    raw = unb64(secret);
  } catch {
    // Not echoed: the secret must not reach an error or a log.
  }
  if (raw?.length !== 32)
    throw new ModelKeySecretError("MODEL_KEY_SECRET must be base64 of 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Whether a stored value is the sealed form rather than a plain-text key from before 1786. */
export const isSealed = (stored: string): boolean => stored.startsWith(PREFIX);

/** The stored form of `apiKey`; throws `ModelKeySecretError` when there is no usable secret. */
export async function sealKey(secret: string | undefined, apiKey: string): Promise<string> {
  const key = await importSecret(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(apiKey),
  );
  return `${PREFIX}${b64(iv)}:${b64(new Uint8Array(sealed))}`;
}

/**
 * The key a stored value holds. A plain-text value is returned as it is, whatever the secret; a
 * sealed one needs the secret (`ModelKeySecretError`) and the right one (`ModelKeyUnreadableError`).
 */
export async function openKey(secret: string | undefined, stored: string): Promise<string> {
  if (!isSealed(stored)) return stored;
  const key = await importSecret(secret);
  try {
    const [iv, sealed] = stored.slice(PREFIX.length).split(":");
    if (!iv || !sealed) throw new Error("malformed");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv) },
      key,
      unb64(sealed),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new ModelKeyUnreadableError();
  }
}
