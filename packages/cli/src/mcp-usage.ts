/** Kept apart from `mcp.ts` so `run.ts` can print it without loading the MCP SDK. */
export const MCP_USAGE = `pixelslash mcp [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--base BRANCH] [--figma-token-path PATH]
A stdio MCP server for a coding agent: it reads builds, snapshots, flakes and detection flags, runs
the local fix loop (check_local, capture_local, check_flake, suggest_ignore, resolve_flake) and
drives this worktree's \`pixelslash dev\` session (start, run, latest, pin, spec, stop). It accepts,
rejects, uploads and writes to the config nothing; resolve_flake resolves a flake only after a
stable run here. Add it with \`claude mcp add pixelslash -- pixelslash mcp\`.`;
