#!/usr/bin/env bun
import { useNativePngCodec } from "@pixelslash/engine/png-native";
import { run } from "./run.ts";

// The CLI runs on Bun, which loads the native PNG codec; the hosted app keeps pngjs.
await useNativePngCodec();
process.exit(await run(process.argv.slice(2)));
