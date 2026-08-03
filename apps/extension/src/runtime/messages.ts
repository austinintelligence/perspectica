import {
  AnalysisPreferencesSchema,
  ArticleDocumentSchema,
  ContentTypeSchema,
} from "@perspectica/contracts";
import { AnalysisModeSchema } from "@perspectica/contracts/preferences";
import { PipelineEventSchema } from "@perspectica/contracts/events";
import { ReportSectionSchema } from "@perspectica/contracts/report";
import type { PipelineEvent } from "@perspectica/contracts/events";
import { z } from "zod";
import { describeError } from "./redaction";

const requiredText = z.string().trim().min(1);
const requestId = requiredText.max(128);
const jobId = requiredText.max(128);
const runToken = requiredText.max(128);
const cacheScope = requiredText.max(256).nullable().optional();
const sequence = z.number().int().nonnegative();

// Increment this whenever the side panel, service worker, and offscreen
// analysis runtime must be reloaded as one unit. A load-unpacked extension can
// otherwise mix a freshly read side-panel bundle with an older, still-running
// MV3 service worker or offscreen document.
export const PERSPECTICA_RUNTIME_PROTOCOL = 6;

export const SearchProviderSchema = z.enum(["free", "chatgpt", "exa"]);
export type SearchProviderKind = z.infer<typeof SearchProviderSchema>;

export const ExtensionPreferencesSchema = AnalysisPreferencesSchema.extend({
  mode: AnalysisModeSchema,
  searchProvider: SearchProviderSchema,
  rememberChatGpt: z.boolean(),
});
export type ExtensionPreferences = z.infer<typeof ExtensionPreferencesSchema>;

export const DEFAULT_EXTENSION_PREFERENCES: ExtensionPreferences = {
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  mode: "balanced",
  depth: "balanced",
  searchProvider: "free",
  rememberChatGpt: true,
};

export const PublicAccountSchema = z.object({
  accountId: requiredText.max(500),
  email: z.string().trim().email().optional(),
  name: z.string().trim().max(500).optional(),
  plan: z.string().trim().max(100).optional(),
});
export type PublicAccount = z.infer<typeof PublicAccountSchema>;

export const AuthStateSchema = z.object({
  status: z.enum(["loading", "unauthenticated", "pending", "authenticated", "expired", "error"]),
  account: PublicAccountSchema.nullable(),
  remembered: z.boolean(),
  models: z.array(requiredText.max(200)).max(100),
  error: z.string().trim().max(1_000).nullable(),
});
export type AuthState = z.infer<typeof AuthStateSchema>;

export const DeviceAuthorizationSchema = z.object({
  userCode: requiredText.max(100),
  verificationUrl: z.string().url(),
  expiresAt: z.number().int().positive(),
  intervalMs: z.number().int().positive(),
});
export type DeviceAuthorization = z.infer<typeof DeviceAuthorizationSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "extracting",
  "analyzing",
  "complete",
  "partial",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const AnalysisLogInputSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  level: z.enum(["debug", "info", "warn", "error"]),
  scope: requiredText.max(120),
  event: requiredText.max(160),
  message: requiredText.max(2_000),
  payload: z.string().max(12_000).nullable(),
});
export type AnalysisLogInput = z.infer<typeof AnalysisLogInputSchema>;

export const AnalysisLogEntrySchema = AnalysisLogInputSchema.extend({
  sequence: z.number().int().positive(),
});
export type AnalysisLogEntry = z.infer<typeof AnalysisLogEntrySchema>;

export const AnalysisJobSchema = z.object({
  id: jobId,
  tabId: z.number().int().positive(),
  tabUrl: z.string().url(),
  articleFingerprint: z.string().trim().max(128).nullable(),
  // A report is valid only for the model, reasoning level, and search
  // provider that produced it. Null keeps jobs from older unpacked builds
  // readable, but those jobs are never eligible for reuse.
  analysisConfigFingerprint: z.string().trim().max(256).nullable().default(null),
  status: JobStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  error: z.string().trim().max(1_000).nullable(),
  // Event bodies live in the IndexedDB journal. This retained field is a
  // narrow migration boundary: legacy ring-buffer payloads are discarded and
  // new V2 jobs always expose an empty compatibility array.
  events: z
    .unknown()
    .default([])
    .transform(() => [] as PipelineEvent[]),
  // Defaults keep jobs created by older unpacked builds readable while every
  // new run receives an explicit owner and monotonic revision metadata.
  runToken: runToken.nullable().default(null),
  revision: sequence.default(0),
  lastEventSequence: sequence.default(0),
});
export type AnalysisJob = z.infer<typeof AnalysisJobSchema>;

export const ArticlePreviewSchema = z.object({
  title: requiredText.max(2_000),
  author: z.string().trim().max(2_000).nullable(),
  publication: z.string().trim().max(1_000).nullable(),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  contentType: ContentTypeSchema,
  tabUrl: z.string().url(),
  articleFingerprint: requiredText.max(128),
});
export type ArticlePreview = z.infer<typeof ArticlePreviewSchema>;

export const OffscreenAnalysisRequestSchema = z.object({
  article: ArticleDocumentSchema,
  client: z.object({ extensionVersion: requiredText.max(100) }),
  // Legacy resumable requests may omit the mode; the offscreen runtime maps
  // those records to Balanced at the migration boundary.
  preferences: AnalysisPreferencesSchema.extend({ mode: AnalysisModeSchema.optional() }).optional(),
});
export type OffscreenAnalysisRequest = z.infer<typeof OffscreenAnalysisRequestSchema>;

export const AnalysisResumeDataSchema = z.object({
  runToken,
  request: OffscreenAnalysisRequestSchema,
  searchProvider: SearchProviderSchema,
  cacheScope,
});
export type AnalysisResumeData = z.infer<typeof AnalysisResumeDataSchema>;

export const EncryptedResumeEnvelopeSchema = z.object({
  jobId,
  resume: AnalysisResumeDataSchema,
});
export type EncryptedResumeEnvelope = z.infer<typeof EncryptedResumeEnvelopeSchema>;

export const RUNTIME_PORT_NAME = "perspectica.runtime" as const;

const baseRequest = z.object({ requestId });

export const ExtensionRequestSchema = z.discriminatedUnion("type", [
  baseRequest.extend({ type: z.literal("runtime.getState") }),
  baseRequest.extend({
    type: z.literal("auth.begin"),
    remember: z.boolean(),
  }),
  baseRequest.extend({ type: z.literal("auth.getPending") }),
  baseRequest.extend({ type: z.literal("auth.poll") }),
  baseRequest.extend({ type: z.literal("auth.disconnect") }),
  baseRequest.extend({ type: z.literal("auth.listModels") }),
  baseRequest.extend({ type: z.literal("preferences.get") }),
  baseRequest.extend({
    type: z.literal("preferences.update"),
    preferences: ExtensionPreferencesSchema,
  }),
  baseRequest.extend({
    type: z.literal("providers.saveExaKey"),
    apiKey: requiredText.max(1_000),
  }),
  baseRequest.extend({
    type: z.literal("providers.testExaKey"),
    apiKey: requiredText.max(1_000),
  }),
  baseRequest.extend({ type: z.literal("providers.clearExaKey") }),
  baseRequest.extend({
    type: z.literal("providers.test"),
    provider: SearchProviderSchema,
  }),
  baseRequest.extend({ type: z.literal("article.preview") }),
  baseRequest.extend({ type: z.literal("analysis.start"), forceNew: z.boolean().optional() }),
  baseRequest.extend({
    type: z.literal("analysis.retry"),
    jobId,
    sections: z.array(ReportSectionSchema).min(1).max(6),
  }),
  baseRequest.extend({ type: z.literal("analysis.getJob"), jobId }),
  baseRequest.extend({
    type: z.literal("analysis.getEventsSince"),
    jobId,
    lastSequence: sequence,
  }),
  baseRequest.extend({ type: z.literal("analysis.getLogs") }),
  baseRequest.extend({ type: z.literal("analysis.clearLogs") }),
  baseRequest.extend({ type: z.literal("research.cache.clear") }),
  baseRequest.extend({ type: z.literal("analysis.cancel"), jobId }),
]);
export type ExtensionRequest = z.infer<typeof ExtensionRequestSchema>;
type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never;
export type ExtensionRequestInput = WithoutRequestId<ExtensionRequest>;

export const InternalRequestSchema = z.discriminatedUnion("type", [
  baseRequest.extend({ type: z.literal("internal.auth.getTokens") }),
  baseRequest.extend({
    type: z.literal("internal.providers.getSecret"),
    provider: SearchProviderSchema,
  }),
  baseRequest.extend({
    type: z.literal("internal.analysis.event"),
    jobId,
    runToken,
    sequence: sequence.positive(),
    event: PipelineEventSchema,
  }),
  baseRequest.extend({
    type: z.literal("internal.analysis.log"),
    jobId,
    runToken,
    entry: AnalysisLogInputSchema,
  }),
  baseRequest.extend({
    type: z.literal("internal.analysis.finished"),
    jobId,
    runToken,
    sequence: sequence.positive(),
  }),
  baseRequest.extend({
    type: z.literal("internal.analysis.failed"),
    jobId,
    runToken,
    sequence: sequence.positive(),
    error: requiredText.max(1_000),
  }),
]);
export type InternalRequest = z.infer<typeof InternalRequestSchema>;
export type InternalRequestInput = WithoutRequestId<InternalRequest>;

export const OffscreenCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("offscreen.runtime.ping"),
    protocol: z.literal(PERSPECTICA_RUNTIME_PROTOCOL),
  }),
  z.object({
    type: z.literal("offscreen.analysis.start"),
    protocol: z.literal(PERSPECTICA_RUNTIME_PROTOCOL),
    jobId,
    runToken,
    initialSequence: sequence.default(0),
    request: OffscreenAnalysisRequestSchema,
    searchProvider: SearchProviderSchema,
    cacheScope,
  }),
  z.object({
    type: z.literal("offscreen.analysis.cancel"),
    protocol: z.literal(PERSPECTICA_RUNTIME_PROTOCOL),
    jobId,
    runToken,
  }),
  z.object({
    type: z.literal("offscreen.analysis.retry"),
    protocol: z.literal(PERSPECTICA_RUNTIME_PROTOCOL),
    jobId,
    runToken,
    initialSequence: sequence.default(0),
    request: OffscreenAnalysisRequestSchema,
    searchProvider: SearchProviderSchema,
    cacheScope,
    sections: z.array(ReportSectionSchema).min(1).max(6),
  }),
  z.object({
    type: z.literal("offscreen.providers.test"),
    protocol: z.literal(PERSPECTICA_RUNTIME_PROTOCOL),
    provider: SearchProviderSchema,
    preferences: AnalysisPreferencesSchema.extend({ mode: AnalysisModeSchema }),
    cacheScope,
  }),
]);
export type OffscreenCommand = z.infer<typeof OffscreenCommandSchema>;

export const ExtensionResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), requestId, data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    requestId,
    error: requiredText.max(1_000),
    code: requiredText.max(100).optional(),
  }),
]);
export type ExtensionResponse = z.infer<typeof ExtensionResponseSchema>;

export const RuntimePushSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth.changed"), auth: AuthStateSchema }),
  z.object({ type: z.literal("analysis.jobChanged"), job: AnalysisJobSchema }),
  z.object({
    type: z.literal("analysis.eventDelta"),
    jobId,
    runToken: runToken.nullable(),
    revision: sequence,
    sequence: sequence.positive(),
    event: PipelineEventSchema,
  }),
]);
export type RuntimePush = z.infer<typeof RuntimePushSchema>;

export interface RuntimeState {
  runtimeProtocol: number;
  auth: AuthState;
  preferences: ExtensionPreferences;
  activeJob: AnalysisJob | null;
  hasExaKey: boolean;
}

export function createRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export function publicError(error: unknown, fallback: string): string {
  return describeError(error, fallback);
}
