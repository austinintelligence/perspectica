import {
  AnalysisResumeDataSchema,
  AnalysisJobSchema,
  AnalysisLogEntrySchema,
  AnalysisLogInputSchema,
  type AnalysisJob,
  type AnalysisLogEntry,
  type AnalysisLogInput,
  type AnalysisResumeData,
} from "../runtime/messages";
import type { AnalysisEnvelope, PipelineEvent } from "@perspectica/contracts/events";
import type { JsonStorageArea } from "./areas";
import type {
  EncryptedAnalysisHistoryEntry,
  EncryptedAnalysisHistoryStore,
} from "./analysis-history";
import { AnalysisJournal } from "./job-journal";

const ACTIVE_JOB_KEY = "perspectica.jobs.active.v1";
const JOB_PREFIX = "perspectica.jobs.v1.";
const LOG_PREFIX = "perspectica.jobs.logs.v1.";
const RESUME_PREFIX = "perspectica.jobs.resume.v1.";
const MAX_LOG_ENTRIES = 400;

export interface EventCommitResult {
  accepted: boolean;
  duplicate?: boolean;
  gap?: boolean;
  job?: AnalysisJob;
  envelope?: AnalysisEnvelope;
}

export class JobStore {
  private readonly logTails = new Map<string, Promise<void>>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: JsonStorageArea,
    private readonly journal = new AnalysisJournal(),
    private readonly history?: Pick<EncryptedAnalysisHistoryStore, "get" | "retain" | "clear">,
    private readonly onLegacyInvalidated?: () => Promise<void>,
  ) {}

  async get(id: string): Promise<AnalysisJob | undefined> {
    const raw = await this.storage.get(`${JOB_PREFIX}${id}`);
    const parsed = AnalysisJobSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const resume = await this.storage.get(`${RESUME_PREFIX}${id}`);
    if (!isLegacyJobRecord(raw, resume)) return parsed.data;

    // V1 event bodies are a different wire protocol. Never replay them as V2
    // pipeline events; invalidate the interrupted report instead of showing a
    // blank terminal report or dispatching an incompatible resume payload.
    const invalidated = AnalysisJobSchema.parse({
      ...parsed.data,
      events: [],
      status: "failed",
      runToken: null,
      revision: parsed.data.revision + 1,
      lastEventSequence: 0,
      updatedAt: new Date().toISOString(),
      error: "This analysis was interrupted by an extension update. Start a new analysis.",
    });
    await Promise.all([
      this.storage.set(`${JOB_PREFIX}${id}`, invalidated),
      this.storage.remove(`${RESUME_PREFIX}${id}`),
      this.journal.clearEvents(id),
      this.journal.clearLogs(id),
    ]);
    await this.onLegacyInvalidated?.();
    return invalidated;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let next: Promise<T>;
    next = previous.catch(() => undefined).then(operation);
    this.mutationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async setUnsafe(job: AnalysisJob, resume?: AnalysisResumeData): Promise<void> {
    const parsed = AnalysisJobSchema.parse(job);
    const previousId = await this.storage.get<string>(ACTIVE_JOB_KEY);
    const writes: Promise<void>[] = [
      this.storage.set(`${JOB_PREFIX}${parsed.id}`, parsed),
      this.storage.set(ACTIVE_JOB_KEY, parsed.id),
    ];
    if (resume) {
      writes.push(
        this.storage.set(`${RESUME_PREFIX}${parsed.id}`, AnalysisResumeDataSchema.parse(resume)),
      );
    } else if (["complete", "partial", "failed", "cancelled"].includes(parsed.status)) {
      // Terminal jobs must not be restarted after a service-worker restart.
      writes.push(this.storage.remove(`${RESUME_PREFIX}${parsed.id}`));
    }
    await Promise.all(writes);
    if (previousId && previousId !== parsed.id) {
      await Promise.all([
        this.storage.remove(`${JOB_PREFIX}${previousId}`),
        this.storage.remove(`${RESUME_PREFIX}${previousId}`),
      ]);
      await Promise.all([this.journal.clearEvents(previousId), this.journal.clearLogs(previousId)]);
    }
  }

  async set(job: AnalysisJob, resume?: AnalysisResumeData): Promise<void> {
    await this.enqueueMutation(() => this.setUnsafe(job, resume));
  }

  /** Atomically read and update a job, preventing out-of-order event races. */
  async update(
    id: string,
    updater: (current: AnalysisJob) => AnalysisJob | undefined | Promise<AnalysisJob | undefined>,
  ): Promise<AnalysisJob | undefined> {
    return this.enqueueMutation(async () => {
      const current = await this.get(id);
      if (!current) return undefined;
      const updated = await updater(current);
      if (!updated) return undefined;
      await this.setUnsafe(updated);
      return AnalysisJobSchema.parse(updated);
    });
  }

  async getResume(id: string): Promise<AnalysisResumeData | undefined> {
    const parsed = AnalysisResumeDataSchema.safeParse(
      await this.storage.get(`${RESUME_PREFIX}${id}`),
    );
    return parsed.success ? parsed.data : undefined;
  }

  async getActive(): Promise<AnalysisJob | undefined> {
    const id = await this.storage.get<string>(ACTIVE_JOB_KEY);
    return typeof id === "string" ? this.get(id) : undefined;
  }

  async clearActive(id?: string): Promise<void> {
    const active = await this.storage.get<string>(ACTIVE_JOB_KEY);
    if (!id || active === id) await this.storage.remove(ACTIVE_JOB_KEY);
  }

  async appendLog(id: string, input: AnalysisLogInput): Promise<void> {
    const entry = AnalysisLogInputSchema.parse(input);
    const previous = this.logTails.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const existing = await this.getLogs(id);
        const sequence = (existing.at(-1)?.sequence ?? 0) + 1;
        await this.journal.appendLog(id, AnalysisLogEntrySchema.parse({ ...entry, sequence }));
      });
    this.logTails.set(id, next);
    try {
      await next;
    } finally {
      if (this.logTails.get(id) === next) this.logTails.delete(id);
    }
  }

  async getLogs(id: string): Promise<AnalysisLogEntry[]> {
    const journalLogs = await this.journal.getLogs(id);
    if (journalLogs.length > 0) return journalLogs;
    const value = await this.storage.get(`${LOG_PREFIX}${id}`);
    const parsed = AnalysisLogEntrySchema.array().max(MAX_LOG_ENTRIES).safeParse(value);
    return parsed.success ? parsed.data : [];
  }

  async clearLogs(id: string): Promise<void> {
    await this.journal.clearLogs(id);
    await this.storage.remove(`${LOG_PREFIX}${id}`);
  }

  async getHistory(): Promise<EncryptedAnalysisHistoryEntry[]> {
    return this.history ? this.history.get() : [];
  }

  async clearHistory(): Promise<void> {
    await this.history?.clear();
  }

  /**
   * Persist the journal row before advancing the job cursor. If storage fails
   * after the row is durable, a retry of the same request finds the row and
   * completes the cursor update idempotently instead of losing the event.
   */
  async commitEvent(input: {
    jobId: string;
    runToken: string;
    sequence: number;
    event: PipelineEvent;
  }): Promise<EventCommitResult> {
    return this.enqueueMutation(async () => {
      const current = await this.get(input.jobId);
      if (!current || current.runToken !== input.runToken) {
        return { accepted: false };
      }
      const existing = await this.journal.getEvent(input.jobId, input.sequence);
      if (existing) {
        if (
          existing.runToken !== input.runToken ||
          JSON.stringify(existing.event) !== JSON.stringify(input.event)
        )
          return { accepted: false };
        if (current.lastEventSequence >= input.sequence)
          return { accepted: false, duplicate: true, envelope: existing };
        if (terminalStatus(current.status)) return { accepted: false, envelope: existing };
        if (input.sequence !== current.lastEventSequence + 1)
          return { accepted: false, gap: true, envelope: existing };
        const updated = await this.setCommittedEvent(current, existing);
        return { accepted: true, job: updated, envelope: existing };
      }
      if (terminalStatus(current.status)) return { accepted: false };
      if (input.sequence <= current.lastEventSequence) return { accepted: false };
      if (input.sequence !== current.lastEventSequence + 1) return { accepted: false, gap: true };
      const envelope: AnalysisEnvelope = {
        protocol: 2,
        jobId: input.jobId,
        runToken: input.runToken,
        sequence: input.sequence,
        revision: current.revision + 1,
        event: input.event,
      };
      // This write is intentionally before setUnsafe. A failed job write can
      // be repaired by the same request after a service-worker restart.
      await this.journal.appendEvent(envelope);
      const updated = await this.setCommittedEvent(current, envelope);
      return { accepted: true, job: updated, envelope };
    });
  }

  private async setCommittedEvent(
    current: AnalysisJob,
    envelope: AnalysisEnvelope,
  ): Promise<AnalysisJob> {
    const terminal =
      envelope.event.type === "analysis.completed"
        ? envelope.event.data.status
        : envelope.event.type === "analysis.failed"
          ? "failed"
          : envelope.event.type === "analysis.cancelled"
            ? "cancelled"
            : null;
    const updated = AnalysisJobSchema.parse({
      ...current,
      events: [],
      status: terminal ?? "analyzing",
      revision: envelope.revision,
      lastEventSequence: envelope.sequence,
      updatedAt: new Date().toISOString(),
      error: null,
    });
    await this.setUnsafe(updated);
    if (terminal && this.history) {
      try {
        const events = await this.journal.eventsSince(current.id, 0, 512);
        await this.history.retain(updated, events);
      } catch {
        // Encrypted retention is a convenience archive. Journal durability
        // and the active report must not depend on vault/quota availability.
      }
    }
    return updated;
  }

  async getEventsSince(id: string, sequence: number): Promise<AnalysisEnvelope[]> {
    return this.journal.eventsSince(id, sequence);
  }

  async clearEvents(id: string): Promise<void> {
    await this.journal.clearEvents(id);
  }
}

function terminalStatus(status: AnalysisJob["status"]): boolean {
  return ["complete", "partial", "failed", "cancelled"].includes(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLegacyJobRecord(value: unknown, resume: unknown): boolean {
  if (!isRecord(value)) return false;
  if ("analysisId" in value) return true;
  if (Array.isArray(value.events) && value.events.length > 0) return true;
  if (value.status !== "queued" && value.status !== "extracting" && value.status !== "analyzing") {
    return false;
  }
  if (typeof value.runToken !== "string") return true;
  if (value.searchProvider === "free") return true;
  if (isRecord(resume) && isRecord(resume.request)) {
    const preferences = resume.request.preferences;
    if (isRecord(preferences) && !("mode" in preferences)) return true;
  }
  return false;
}
