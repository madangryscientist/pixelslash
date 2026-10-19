/**
 * The blob store's seam: R2 in production, a filesystem or S3 store for a later Docker
 * self-host. Callers never hold a raw store; they get one scoped to an org with `orgBlobs`.
 */
export interface BlobStore {
  put(key: string, body: ArrayBuffer | ReadableStream, contentType: string): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
}

export function r2BlobStore(bucket: R2Bucket): BlobStore {
  return {
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await bucket.get(key);
      return object?.body ?? null;
    },
    delete: (key) => bucket.delete(key),
  };
}

const SAFE_SEGMENT = /^[\w.-]+$/;

/** Every key lands under `orgs/<orgId>/`; a key that could climb out of it is refused. */
export function orgBlobs(store: BlobStore, orgId: string): BlobStore {
  const scoped = (key: string) => {
    const parts = key.split("/");
    if (
      !SAFE_SEGMENT.test(orgId) ||
      !parts.every((p) => SAFE_SEGMENT.test(p) && p !== ".." && p !== ".")
    )
      throw new Error(`unsafe blob key: ${key}`);
    return `orgs/${orgId}/${key}`;
  };
  return {
    put: (key, body, contentType) => store.put(scoped(key), body, contentType),
    get: (key) => store.get(scoped(key)),
    delete: (key) => store.delete(scoped(key)),
  };
}
