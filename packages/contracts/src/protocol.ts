import { z } from "zod";
import { AnalysisEnvelopeSchema, PipelineEventSchema } from "./events";

export const ANALYSIS_PROTOCOL_VERSION = 2 as const;

export const AnalysisReconnectRequestSchema = z.object({
  type: z.literal("analysis.getEventsSince"),
  jobId: z.string().trim().min(1).max(160),
  lastSequence: z.number().int().nonnegative(),
});
export type AnalysisReconnectRequest = z.infer<typeof AnalysisReconnectRequestSchema>;

export const AnalysisReconnectResponseSchema = z.object({
  jobId: z.string().trim().min(1).max(160),
  lastSequence: z.number().int().nonnegative(),
  events: z.array(AnalysisEnvelopeSchema).max(256),
  complete: z.boolean(),
});
export type AnalysisReconnectResponse = z.infer<typeof AnalysisReconnectResponseSchema>;

export const RuntimePipelineDeltaSchema = z.object({
  type: z.literal("analysis.eventDelta"),
  envelope: AnalysisEnvelopeSchema,
});
export type RuntimePipelineDelta = z.infer<typeof RuntimePipelineDeltaSchema>;

export type RuntimePipelineEvent = z.infer<typeof PipelineEventSchema>;
