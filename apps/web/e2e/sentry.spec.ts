import { expect, test } from "@playwright/test";
import { SENTRY_INGEST, SERVER } from "./ports";

// The run's Worker has a DSN pointing at e2e/sentry-ingest.ts (vite.config.ts), so the review app
// reports to a sink the spec can read (PS-227).

const COOKIE_SECRET = "browsercookiesecret";
const TOKEN = "psu_0123456789abcdefSECRET";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function envelopes(): Promise<string[]> {
  const reply = await fetch(`${SENTRY_INGEST}/envelopes`);
  const body: unknown = await reply.json();
  return Array.isArray(body) ? body.map(String) : [];
}

test("a browser error reaches Sentry with release and environment, and no cookie, token or image", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "ps_session", value: COOKIE_SECRET, url: SERVER }]);
  await page.goto("/");

  // The reporter loads after hydration, so throw until it is listening; each message differs, so
  // none is dropped as a repeat.
  let attempt = 0;
  await expect
    .poll(
      async () => {
        attempt += 1;
        const message = `e2e browser error ${attempt} ${TOKEN} data:image/png;base64,${PNG}`;
        await page.evaluate((text) => {
          setTimeout(() => {
            throw new Error(text);
          });
        }, message);
        return (await envelopes()).filter((text) => text.includes("e2e browser error")).length;
      },
      { intervals: [250], timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  const sent = (await envelopes()).filter((text) => text.includes("e2e browser error"));
  const text = sent.join("\n");
  expect(text).toContain('"release":"e2e"');
  expect(text).toContain('"environment":"e2e"');
  for (const secret of [COOKIE_SECRET, TOKEN, PNG, "ps_session"]) {
    expect(text, `the envelope carries ${secret}`).not.toContain(secret);
  }
});
