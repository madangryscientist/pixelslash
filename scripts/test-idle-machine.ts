import { vi } from "vitest";

/**
 * A Vitest `setupFiles` entry: every test file sees an idle machine. `captureInto` sizes its default
 * worker count from the 1-minute load average and says so on stderr when load lowered it (PS-474),
 * so a test that reads the warnings of a capture would fail on a busy host (a CI runner, a desktop
 * with other builds). The load-aware default has its own tests, which inject cores and load.
 */
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, loadavg: () => [0, 0, 0] };
});
