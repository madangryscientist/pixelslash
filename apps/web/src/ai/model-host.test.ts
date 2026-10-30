import { describe, expect, test, vi } from "vitest";
import { ModelError, explainRegion, guardedFetch } from "./model";
import { type HostResolver, ModelHostError, checkModelHost, refusedAddress } from "./model-host";

/** The model host guard (PS-250): a stranger's base URL may not reach the server's own network. */

const publicDns = { allowPrivate: false, resolve: async () => ["203.0.113.10"] };
const allowed = { allowPrivate: true };

describe("refusedAddress", () => {
  test.each([
    ["0.0.0.0", "this-network"],
    ["127.0.0.1", "loopback"],
    ["127.255.1.2", "loopback"],
    ["10.1.2.3", "RFC 1918"],
    ["172.16.0.1", "RFC 1918"],
    ["172.31.255.255", "RFC 1918"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "CGNAT"],
    ["100.127.255.255", "CGNAT"],
  ])("refuses IPv4 %s (%s)", (ip, why) => {
    expect(refusedAddress(ip)).toContain(why);
  });

  test.each([
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "unique local"],
    ["fd12:3456:789a::1", "unique local"],
    ["fe80::1%eth0", "link-local"],
    ["fec0::1", "site-local"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:c0a8:10a", "RFC 1918"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::10.0.0.1", "RFC 1918"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["2002:c0a8:0001::1", "RFC 1918"],
    ["::0.0.0.5", "this-network"],
  ])("refuses IPv6 %s (%s)", (ip, why) => {
    expect(refusedAddress(ip)).toContain(why);
  });

  test.each([
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "169.253.1.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "2002:0808:0808::1",
  ])("lets public %s through", (ip) => {
    expect(refusedAddress(ip)).toBeNull();
  });
});

describe("checkModelHost", () => {
  test.each([
    "http://localhost:11434/v1",
    "http://api.localhost/v1",
    "http://ollama.local/v1",
    "http://metadata.google.internal/v1",
    "http://model/v1",
    "http://127.0.0.1/v1",
    "http://2130706433/v1", // 127.0.0.1 as one number; URL parsing normalises it
    "http://0x7f.1/v1",
    "http://[::ffff:a9fe:a9fe]/v1",
    "http://169.254.169.254/latest/meta-data",
  ])("refuses %s without a lookup", async (url) => {
    const resolve = vi.fn<HostResolver>(async () => ["203.0.113.10"]);
    await expect(checkModelHost(url, { allowPrivate: false, resolve })).rejects.toBeInstanceOf(
      ModelHostError,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  test("refuses a scheme other than http(s), even when private hosts are allowed", async () => {
    await expect(checkModelHost("file:///etc/passwd", allowed)).rejects.toThrow(/http or https/);
    await expect(checkModelHost("gopher://model.example/", allowed)).rejects.toThrow(
      ModelHostError,
    );
  });

  test("refuses a public name that resolves to a private address", async () => {
    const rebound = { allowPrivate: false, resolve: async () => ["203.0.113.10", "10.0.0.7"] };
    await expect(checkModelHost("https://model.example/v1", rebound)).rejects.toThrow(
      /model\.example \(10\.0\.0\.7\) is private/,
    );
    const v6 = { allowPrivate: false, resolve: async () => ["fd00::1"] };
    await expect(checkModelHost("https://model.example/v1", v6)).rejects.toThrow(ModelHostError);
  });

  test("refuses a name that does not resolve, and ignores the CNAMEs in an answer", async () => {
    const none = {
      allowPrivate: false,
      resolve: async () => {
        throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
      },
    };
    await expect(checkModelHost("https://nope.example/v1", none)).rejects.toThrow(
      /does not resolve/,
    );
    const cnameOnly = { allowPrivate: false, resolve: async () => ["edge.example.net."] };
    await expect(checkModelHost("https://model.example/v1", cnameOnly)).rejects.toThrow(
      /does not resolve/,
    );
    const cname = { allowPrivate: false, resolve: async () => ["edge.example.net.", "8.8.8.8"] };
    await expect(checkModelHost("https://model.example/v1", cname)).resolves.toBeInstanceOf(URL);
  });

  test("lets a public host through", async () => {
    await expect(checkModelHost("https://api.deepseek.com/v1", publicDns)).resolves.toBeInstanceOf(
      URL,
    );
    await expect(checkModelHost("https://8.8.8.8/v1", publicDns)).resolves.toBeInstanceOf(URL);
  });

  test("PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS lets every private form through, with no lookup", async () => {
    const resolve = vi.fn<HostResolver>(async () => ["10.0.0.7"]);
    for (const url of [
      "http://localhost:11434/v1",
      "http://10.0.0.9:4180/v1",
      "http://[::1]:8080/v1",
      "http://ollama.local/v1",
      "http://model.example/v1",
    ])
      await expect(checkModelHost(url, { allowPrivate: true, resolve })).resolves.toBeInstanceOf(
        URL,
      );
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("the call-time guard", () => {
  const endpoint = { baseUrl: "http://169.254.169.254", model: "m", apiKey: "sk-secret-value" };
  const images = {
    main: new Uint8Array([1]),
    branch: new Uint8Array([2]),
    diff: new Uint8Array([3]),
  };

  test("a stored private host is refused before any request goes out", async () => {
    const sent = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      // The default fetcher is the guarded one.
      const refused = explainRegion(endpoint, images, { buildId: "b1" });
      await expect(refused).rejects.toThrow(ModelError);
      await expect(refused).rejects.toThrow(/link-local/);
      expect(sent).not.toHaveBeenCalled();
    } finally {
      sent.mockRestore();
    }
  });

  test("a redirect is not followed", async () => {
    const sent = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 302 }));
    try {
      const model = { ...endpoint, baseUrl: "https://model.example" };
      await expect(
        explainRegion(model, images, { buildId: "b1", fetcher: guardedFetch(publicDns) }),
      ).rejects.toThrow(/answered 302/);
      expect(sent.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    } finally {
      sent.mockRestore();
    }
  });
});
