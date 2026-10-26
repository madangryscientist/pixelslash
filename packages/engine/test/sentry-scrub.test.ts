import { describe, expect, test } from "vitest";
import { scrubEvent } from "../src/sentry-scrub.ts";

const PNG_B64 = `iVBORw0KGgo${"A".repeat(400)}`;

describe("the error report scrubber (PS-227)", () => {
  test("keeps the message, stack, release and environment", () => {
    const event = {
      release: "abc123",
      environment: "lan",
      exception: {
        values: [
          {
            type: "Error",
            value: "diff blew up",
            stacktrace: { frames: [{ filename: "src/diff.ts", lineno: 4 }] },
          },
        ],
      },
    };
    expect(scrubEvent(event)).toEqual(event);
  });

  test("drops the body, cookies, query string, user and breadcrumbs", () => {
    const out = scrubEvent({
      user: { id: "u1", ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: "fetch /api" }],
      request: {
        url: "https://x.test/images/o/a.png?exp=1&sig=deadbeef",
        method: "POST",
        data: "raw body",
        cookies: { session: "s" },
        query_string: "sig=deadbeef",
        headers: {
          Cookie: "pixelslash_session=abc",
          Authorization: "Bearer psu_secret123",
          "x-upload-token": "t",
          "User-Agent": "pixelslash/1.0.0",
          "Content-Type": "image/png",
        },
      },
    });
    expect(out).toEqual({
      request: {
        url: "https://x.test/images/o/a.png",
        method: "POST",
        headers: { "User-Agent": "pixelslash/1.0.0", "Content-Type": "image/png" },
      },
    });
  });

  test("redacts tokens, signed URLs and image data wherever they sit in a string or key", () => {
    const out = JSON.stringify(
      scrubEvent({
        message: "upload failed for psu_abcdef123456 and psci_ci0123456789 with Bearer sk-live-xyz",
        extra: {
          figmaToken: "figd_abc",
          link: "https://x.test/i?exp=1&sig=cafe&k=v",
          png: `data:image/png;base64,${PNG_B64}`,
          raw: PNG_B64,
          blob: "Q".repeat(500),
          bytes: new Uint8Array([137, 80, 78, 71]),
          nested: { apiKey: "k", fine: "kept" },
        },
      }),
    );
    for (const leaked of [
      "psu_abcdef123456",
      "psci_ci0123456789",
      "sk-live-xyz",
      "figd_abc",
      "cafe",
      "iVBOR",
      "QQQQ",
    ])
      expect(out).not.toContain(leaked);
    expect(out).toContain("kept");
    expect(out).toContain("[image data]");
  });

  test("redacts image data in place, so the rest of the message survives", () => {
    const out = scrubEvent({ message: `diff blew up on data:image/png;base64,${PNG_B64} twice` });
    expect(out.message).toBe("diff blew up on [image data] twice");
  });
});
