/** `pixelslash/<x.y.z>`, the CLI's User-Agent; null for any other client. */
function cliVersion(request: Request): number[] | null {
  const found = /^pixelslash\/(\d+)\.(\d+)\.(\d+)/.exec(request.headers.get("user-agent") ?? "");
  return found ? found.slice(1).map(Number) : null;
}

/** True when the request is from a CLI older than `min` (`x.y.z`); other clients are never refused. */
export function belowMinimum(request: Request, min: string | undefined): boolean {
  const have = cliVersion(request);
  const want = min?.split(".").map(Number);
  if (!have || !want || want.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i += 1) {
    const diff = (have[i] ?? 0) - (want[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}
