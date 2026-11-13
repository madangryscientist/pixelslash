/**
 * The blob store's seam: R2 in production, a filesystem or S3 store for a later Docker
 * self-host. Callers never hold a raw store; they get one scoped to an org with `orgBlobs`.
 */
export interface BlobStore {
  put(key: string, body: ArrayBuffer | ReadableStream, contentType: string): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
}

/**
 * What the retention sweep needs beyond a request's `BlobStore` (PS-239): list a prefix with its
 * sizes, and delete many keys at once. A separate seam, so only the sweep's store carries it.
 */
export interface SweepBlobStore extends BlobStore {
  /** Every object under the directory `dir` (a key without a trailing slash), with its size. */
  list(dir: string): Promise<{ key: string; size: number }[]>;
  deleteMany(keys: string[]): Promise<void>;
}

/** R2 deletes at most this many keys in one call. */
const R2_DELETE_BATCH = 1000;

/** The part of an R2 bucket the stores use, so a test can hand in a recording view of one. */
type R2Store = Pick<R2Bucket, "put" | "get" | "delete">;

/**
 * Both default to R2's own limits: a list page is 1000 keys (no `limit` is passed) and a delete
 * takes at most `R2_DELETE_BATCH` keys. A test passes small numbers to cross a page or a batch
 * without writing a thousand objects.
 */
export interface R2SweepOptions {
  pageSize?: number;
  deleteBatch?: number;
}

export function r2SweepStore(
  bucket: R2Store & Pick<R2Bucket, "list">,
  { pageSize, deleteBatch = R2_DELETE_BATCH }: R2SweepOptions = {},
): SweepBlobStore {
  return {
    ...r2BlobStore(bucket),
    async list(dir) {
      const found: { key: string; size: number }[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({
          prefix: `${dir}/`,
          ...(pageSize && { limit: pageSize }),
          ...(cursor && { cursor }),
        });
        found.push(...page.objects.map((o) => ({ key: o.key, size: o.size })));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return found;
    },
    async deleteMany(keys) {
      for (let at = 0; at < keys.length; at += deleteBatch)
        await bucket.delete(keys.slice(at, at + deleteBatch));
    },
  };
}

export function r2BlobStore(bucket: R2Store): BlobStore {
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

function scopedKey(orgId: string, key: string): string {
  const parts = key.split("/");
  if (
    !SAFE_SEGMENT.test(orgId) ||
    !parts.every((p) => SAFE_SEGMENT.test(p) && p !== ".." && p !== ".")
  )
    throw new Error(`unsafe blob key: ${key}`);
  return `orgs/${orgId}/${key}`;
}

/** The sweep's view of one org's blobs: keys are as `orgBlobs` takes them, without the org prefix. */
export function orgSweepBlobs(store: SweepBlobStore, orgId: string): SweepBlobStore {
  const prefix = scopedKey(orgId, "x").slice(0, -1);
  return {
    ...orgBlobs(store, orgId),
    async list(dir) {
      const found = await store.list(scopedKey(orgId, dir));
      return found.map((o) => ({ key: o.key.slice(prefix.length), size: o.size }));
    },
    deleteMany: (keys) => store.deleteMany(keys.map((key) => scopedKey(orgId, key))),
  };
}

/** Every key lands under `orgs/<orgId>/`; a key that could climb out of it is refused. */
export function orgBlobs(store: BlobStore, orgId: string): BlobStore {
  const scoped = (key: string) => scopedKey(orgId, key);
  return {
    put: (key, body, contentType) => store.put(scoped(key), body, contentType),
    get: (key) => store.get(scoped(key)),
    delete: (key) => store.delete(scoped(key)),
  };
}
