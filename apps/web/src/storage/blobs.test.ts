import { describe, expect, test } from "vitest";
import { type BlobStore, orgBlobs } from "./blobs";

function memoryStore(): BlobStore & { keys: () => string[] } {
  const data = new Map<string, ArrayBuffer | ReadableStream>();
  return {
    keys: () => [...data.keys()],
    put: async (key, body) => void data.set(key, body),
    get: async () => null,
    delete: async (key) => void data.delete(key),
  };
}

describe("org blob scoping", () => {
  test("keys land under the org's prefix and cannot climb out of it", async () => {
    const store = memoryStore();
    const blobs = orgBlobs(store, "org-1");
    await blobs.put("builds/b1/home.png", new ArrayBuffer(1), "image/png");

    expect(store.keys()).toEqual(["orgs/org-1/builds/b1/home.png"]);
    expect(() => blobs.put("../org-2/secret.png", new ArrayBuffer(1), "image/png")).toThrow(
      /unsafe/,
    );
    expect(() => blobs.put("/abs.png", new ArrayBuffer(1), "image/png")).toThrow(/unsafe/);
    expect(() => orgBlobs(store, "../x").put("a.png", new ArrayBuffer(1), "image/png")).toThrow(
      /unsafe/,
    );
  });
});
