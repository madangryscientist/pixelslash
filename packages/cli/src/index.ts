#!/usr/bin/env bun
import { run } from "./run.ts";

process.exit(await run(process.argv.slice(2)));
