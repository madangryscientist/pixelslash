import {
  MAX_METRICS_BYTES,
  parseMetricsText,
  type Metrics,
} from "@hackcove/pixelslash-engine/metrics-entry";
import { bad } from "./errors";

/**
 * A snapshot's layout metrics file (PS-294), checked with the engine's own parser: a malformed file
 * is a 400 that names the field. The bytes the client sent are what is stored, so a higher minor
 * version's extra fields survive; only this reader drops them.
 */
export function checkMetricsBytes(bytes: ArrayBuffer): Metrics {
  return parseMetricsText(new TextDecoder().decode(bytes), "metrics", bad, bytes.byteLength);
}

/** The most a `metrics` part may add to an upload's body, for the content-length cap. */
export const METRICS_PART_ALLOWANCE = MAX_METRICS_BYTES;
