#!/usr/bin/env bun
import { exitAfterFlush } from "./exit.ts";
import { run } from "./run.ts";

await exitAfterFlush(await run(process.argv.slice(2)));
