// A child for exit.test.ts: write about 2 MB of JSON to stdout, then exit through the helper
// (`bare` exits with a plain process.exit, to show the test can see the cut).
import { exitAfterFlush } from "../src/exit.ts";

const rows = Array.from({ length: 20000 }, (_, i) => ({ i, text: "x".repeat(90) }));
process.stdout.write(`${JSON.stringify({ rows })}\n`);
process.stderr.write(`${"e".repeat(300_000)}\n`);
if (process.argv[2] === "bare") process.exit(3);
await exitAfterFlush(3);
