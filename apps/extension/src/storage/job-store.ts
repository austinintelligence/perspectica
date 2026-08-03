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
import type { AnalysisEnvelope } from "@perspectica/contracts/events";
import type { JsonStorageArea } from "./areas";
import { AnalysisJournal } from "./job-journal";

const ACTIVE_JOB_KEY = "perspectica.jobs.active.v1";
const JOB_PREFIX = "perspectica.jobs.v1.";
const LOG_PREFIX = "perspectica.jobs.logs.v1.";
const RESUME_PREFIX = "perspectica.jobs.resume.v1.";
const MAX_LOG_ENTRIES = 400;

export class JobStore {
  private readonly logTails = new Map<string, Promise<void>>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: JsonStorageArea,
    private readonly journal = new AnalysisJournal(),
  ) {}

  async get(id: string): Promise<AnalysisJob | undefined> {
    const parsed = AnalysisJobSchema.safeParse(await this.storage.get(`${JOB_PREFIX}${id}`));
    return parsed.success ? parsed.data : undefined;
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

  async appendEvent(envelope: AnalysisEnvelope): Promise<void> {
    await this.journal.appendEvent(envelope);
  }

  async getEventsSince(id: string, sequence: number): Promise<AnalysisEnvelope[]> {
    return this.journal.eventsSince(id, sequence);
  }

  async clearEvents(id: string): Promise<void> {
    await this.journal.clearEvents(id);
  }
}
