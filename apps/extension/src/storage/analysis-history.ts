import type { AnalysisEnvelope } from "@perspectica/contracts/events";
import type { AnalysisJob } from "../runtime/messages";

const MAX_HISTORY_JOBS = 10;
const MAX_HISTORY_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_HISTORY_BYTES = 25 * 1024 * 1024;

export interface EncryptedAnalysisHistoryEntry {
  job: AnalysisJob;
  events: AnalysisEnvelope[];
  savedAt: string;
}

export interface AnalysisHistoryVault {
  readAnalysisHistory<T>(): Promise<T[] | undefined>;
  writeAnalysisHistory<T>(value: T[]): Promise<void>;
  removeAnalysisHistory?(): Promise<void>;
}

function isEntry(value: unknown): value is EncryptedAnalysisHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EncryptedAnalysisHistoryEntry>;
  return Boolean(
    item.job &&
    typeof item.job === "object" &&
    typeof item.job.id === "string" &&
    Array.isArray(item.events) &&
    typeof item.savedAt === "string",
  );
}

function timestamp(entry: EncryptedAnalysisHistoryEntry): number {
  const saved = Date.parse(entry.savedAt);
  if (Number.isFinite(saved)) return saved;
  const updated = Date.parse(entry.job.updatedAt);
  return Number.isFinite(updated) ? updated : 0;
}

/**
 * Encrypted terminal-report retention layered over the V2 journal. The
 * journal remains authoritative for the active job; this store is only a
 * bounded convenience archive and never participates in event sequencing.
 */
export class EncryptedAnalysisHistoryStore {
  constructor(private readonly vault: AnalysisHistoryVault) {}

  private prune(
    entries: readonly EncryptedAnalysisHistoryEntry[],
  ): EncryptedAnalysisHistoryEntry[] {
    const cutoff = Date.now() - MAX_HISTORY_AGE_MS;
    const deduplicated = new Map<string, EncryptedAnalysisHistoryEntry>();
    for (const entry of entries) {
      if (!isEntry(entry) || timestamp(entry) < cutoff) continue;
      deduplicated.set(entry.job.id, {
        job: structuredClone(entry.job),
        events: structuredClone(entry.events),
        savedAt: entry.savedAt,
      });
    }
    const retained = [...deduplicated.values()].sort(
      (left, right) => timestamp(right) - timestamp(left),
    );
    retained.splice(MAX_HISTORY_JOBS);
    while (retained.length > 0 && JSON.stringify(retained).length > MAX_HISTORY_BYTES) {
      retained.pop();
    }
    return retained;
  }

  async get(): Promise<EncryptedAnalysisHistoryEntry[]> {
    const value = await this.vault.readAnalysisHistory<EncryptedAnalysisHistoryEntry>();
    const retained = this.prune(value ?? []);
    if (value && JSON.stringify(value) !== JSON.stringify(retained)) {
      await this.vault.writeAnalysisHistory(retained);
    }
    return retained;
  }

  async retain(job: AnalysisJob, events: readonly AnalysisEnvelope[]): Promise<void> {
    const current = await this.get();
    const next = this.prune([
      {
        job: structuredClone(job),
        events: events.map((event) => structuredClone(event)),
        savedAt: new Date().toISOString(),
      },
      ...current.filter((entry) => entry.job.id !== job.id),
    ]);
    await this.vault.writeAnalysisHistory(next);
  }

  async clear(): Promise<void> {
    if (this.vault.removeAnalysisHistory) {
      await this.vault.removeAnalysisHistory();
    } else {
      await this.vault.writeAnalysisHistory([]);
    }
  }
}
