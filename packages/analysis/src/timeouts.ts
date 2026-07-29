/**
 * Perspectica aims to return a useful analysis within 30 seconds. This is a
 * performance target for telemetry and tuning, not a cancellation deadline.
 */
export const MODEL_RESPONSE_TARGET_MS = 30_000;

/**
 * The hard limit only protects the POC from a genuinely stalled model stream.
 * It deliberately leaves substantially more room than the response target.
 */
export const MODEL_HARD_TIMEOUT = {
  totalMs: 90_000,
  firstChunkMs: 60_000,
  chunkMs: 45_000,
} as const;
