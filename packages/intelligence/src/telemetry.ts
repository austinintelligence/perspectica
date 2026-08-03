export interface PipelineTelemetry {
  readonly startedAt: number;
  phaseDurations: Record<string, number>;
  modelCalls: number;
  searchCalls: number;
  contentReads: number;
  acceptedSources: number;
  rejectedSources: number;
  eventBytes: number;
  storageWrites: number;
  cacheHits: number;
  firstUsefulResultMs: number | null;
  finalLatencyMs: number | null;
  debugRing: string[];
}

export function createTelemetry(now = Date.now): PipelineTelemetry {
  return {
    startedAt: now(),
    phaseDurations: {},
    modelCalls: 0,
    searchCalls: 0,
    contentReads: 0,
    acceptedSources: 0,
    rejectedSources: 0,
    eventBytes: 0,
    storageWrites: 0,
    cacheHits: 0,
    firstUsefulResultMs: null,
    finalLatencyMs: null,
    debugRing: [],
  };
}

export function noteTelemetry(telemetry: PipelineTelemetry, message: string, now = Date.now): void {
  telemetry.debugRing.push(message);
  if (telemetry.debugRing.length > 64) telemetry.debugRing.shift();
  telemetry.eventBytes += message.length;
  telemetry.finalLatencyMs = now() - telemetry.startedAt;
}
