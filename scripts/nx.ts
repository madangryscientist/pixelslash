#!/usr/bin/env bun
/**
 * `bun scripts/nx.ts <nx args>`: nx, with `engines/dotnet` skipped when there is no .NET SDK.
 * The `@nx/dotnet` plugin fails every nx command without an SDK, so a contributor who only
 * touches the TS projects could not run the gate; `NX_DOTNET_DISABLE=true` takes the two dotnet
 * projects out of the graph. With a working `dotnet` nothing changes. The skip is printed, not silent.
 */
function hasDotnet(): boolean {
  try {
    // Run it rather than look it up: a mise shim is on PATH where no SDK is active.
    return Bun.spawnSync(["dotnet", "--version"], { stdout: "ignore", stderr: "ignore" }).success;
  } catch {
    return false;
  }
}

const env: Record<string, string | undefined> = { ...process.env };
if (env.NX_DOTNET_DISABLE === undefined && !hasDotnet()) {
  env.NX_DOTNET_DISABLE = "true";
  console.log("dotnet SDK not found: skipping engines/dotnet");
}

const nx = Bun.spawnSync(["nx", ...process.argv.slice(2)], {
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(nx.exitCode ?? 1);
