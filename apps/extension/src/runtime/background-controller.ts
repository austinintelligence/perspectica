import { ArticleDocumentSchema } from "@perspectica/contracts";
import type { PipelineEvent } from "@perspectica/contracts/events";
import type { ReportSection } from "@perspectica/contracts/report";
import { ChatGptSessionManager } from "../auth/chatgpt-session";
import { ChromeJsonStorageArea, restrictExtensionStorage } from "../storage/areas";
import { CredentialVault } from "../storage/credential-vault";
import { IndexedDbCryptoKeyStore } from "../storage/indexed-db-key-store";
import { IndexedDbEncryptedAnalysisHistoryVault } from "../storage/indexed-db-analysis-history-vault";
import { JobStore } from "../storage/job-store";
import { EvidenceCache } from "../storage/evidence-cache";
import { EncryptedAnalysisHistoryStore } from "../storage/analysis-history";
import { IndexedDbAnalysisArtifactStore } from "../storage/analysis-artifacts";
import { PreferencesStore } from "../storage/preferences-store";
import {
  AnalysisJobSchema,
  ArticlePreviewSchema,
  EncryptedResumeEnvelopeSchema,
  ExtensionRequestSchema,
  InternalRequestSchema,
  OffscreenCommandSchema,
  PERSPECTICA_RUNTIME_PROTOCOL,
  RUNTIME_PORT_NAME,
  publicError,
  type AnalysisJob,
  type AnalysisLogEntry,
  type AnalysisResumeData,
  type ExtensionRequest,
  type ExtensionResponse,
  type InternalRequest,
  type RuntimeState,
  type SearchProviderKind,
} from "./messages";
import { describeError, redactText, redactUrl, serializeRedacted } from "./redaction";
import {
  canReuseAnalysisJob,
  createAnalysisConfigFingerprint,
  tabUrlChanged,
} from "./report-reuse";

const OFFSCREEN_PATH = "offscreen.html";
const EXTRACTOR_PATH = "extractor.js";
const EXTENSION_VERSION = "0.1.0";
const EXA_CONNECTION_TEST_TIMEOUT_MS = 15_000;
let offscreenCreation: Promise<void> | null = null;

function ok(requestId: string, data: unknown): ExtensionResponse {
  return { ok: true, requestId, data };
}

function fail(
  requestId: string,
  error: unknown,
  fallback: string,
  code?: string,
): ExtensionResponse {
  return {
    ok: false,
    requestId,
    error: publicError(error, fallback),
    ...(code ? { code } : {}),
  };
}

function now(): string {
  return new Date().toISOString();
}

function formatAnalysisLogs(
  job: AnalysisJob,
  logs: AnalysisLogEntry[],
  events: PipelineEvent[],
): string {
  const metadata = events.find((event) => event.type === "metadata.ready");
  const analysis = events.find((event) => event.type === "analysis.started");
  const completed = events.find((event) => event.type === "analysis.completed");
  const lines = [
    "Perspectica analysis telemetry",
    `Exported: ${now()}`,
    `Extension: ${EXTENSION_VERSION}`,
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`,
    `Tab URL: ${redactUrl(job.tabUrl)}`,
    `Article fingerprint: ${job.articleFingerprint ?? "unavailable"}`,
    `Model: ${analysis?.type === "analysis.started" ? analysis.data.modelVersion : "unavailable"}`,
    `Reasoning: ${analysis?.type === "analysis.started" ? analysis.data.reasoningEffort : "unavailable"}`,
    `Pipeline: ${analysis?.type === "analysis.started" ? analysis.data.pipelineVersion : "unavailable"}`,
    `Article: ${metadata?.type === "metadata.ready" ? redactText(metadata.data.title) : "unavailable"}`,
    `Publication: ${metadata?.type === "metadata.ready" ? redactText(metadata.data.publication ?? "unavailable") : "unavailable"}`,
    `Author: ${metadata?.type === "metadata.ready" ? redactText(metadata.data.author ?? "unavailable") : "unavailable"}`,
    `Duration: ${completed?.type === "analysis.completed" ? `${completed.data.durationMs}ms` : "incomplete"}`,
    `Failed sections: ${completed?.type === "analysis.completed" ? completed.data.failedSections.join(", ") || "none" : "incomplete"}`,
    "",
    `Telemetry entries (${logs.length})`,
  ];
  for (const entry of logs) {
    lines.push(
      "",
      `#${entry.sequence.toString().padStart(3, "0")} ${entry.timestamp} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.event}`,
      redactText(entry.message),
    );
    if (entry.payload) lines.push(serializeRedacted(entry.payload) ?? "[redacted]");
  }
  lines.push("", `Analysis events (${events.length})`);
  for (const event of events) {
    lines.push(
      "",
      `${event.emittedAt} ${event.type}`,
      serializeRedacted(event.data) ?? "[redacted]",
    );
  }
  if (job.error) lines.push("", "Terminal job error", redactText(job.error));
  lines.push(
    "",
    "Privacy note: credential-shaped values, sensitive URLs, and provider secrets are redacted before export.",
  );
  return lines.join("\n");
}

function isWebPage(url: string | undefined): url is string {
  return Boolean(url && (url.startsWith("http://") || url.startsWith("https://")));
}

function isSidePanelSender(
  sender: chrome.runtime.MessageSender | Record<string, unknown>,
): boolean {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("sidepanel.html");
}

function isOffscreenSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(OFFSCREEN_PATH);
}

async function ensureOffscreenDocument(): Promise<void> {
  const hasDocument =
    typeof chrome.offscreen.hasDocument === "function"
      ? await chrome.offscreen.hasDocument()
      : (
          await chrome.runtime.getContexts({
            contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
            documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
          })
        ).length > 0;
  if (hasDocument) return;
  offscreenCreation ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Run user-requested article analysis outside the MV3 service-worker lifetime.",
    })
    .finally(() => {
      offscreenCreation = null;
    });
  await offscreenCreation;
}

async function ensureCompatibleOffscreenDocument(): Promise<void> {
  await ensureOffscreenDocument();

  const ping = async () =>
    chrome.runtime.sendMessage(
      OffscreenCommandSchema.parse({
        type: "offscreen.runtime.ping",
        protocol: PERSPECTICA_RUNTIME_PROTOCOL,
      }),
    ) as Promise<{ ok?: boolean; protocol?: number } | undefined>;

  let response = await ping().catch(() => undefined);
  if (response?.ok && response.protocol === PERSPECTICA_RUNTIME_PROTOCOL) return;

  // The unpacked directory was rebuilt while an older offscreen document was
  // still alive. Replace it before dispatching work so one job never crosses
  // two runtime versions.
  await chrome.offscreen.closeDocument().catch(() => undefined);
  await ensureOffscreenDocument();
  response = await ping().catch(() => undefined);
  if (!response?.ok || response.protocol !== PERSPECTICA_RUNTIME_PROTOCOL) {
    throw new Error("Perspectica updated in the background. Reopen the extension and try again.");
  }
}

async function broadcast(message: unknown): Promise<void> {
  await chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function testExaConnection(apiKey: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXA_CONNECTION_TEST_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query: "Perspectica connection test",
        type: "fast",
        numResults: 1,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Exa rejected the connection (${response.status}).`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Exa connection test timed out. Try again.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function terminal(status: AnalysisJob["status"]): boolean {
  return (
    status === "complete" || status === "partial" || status === "failed" || status === "cancelled"
  );
}

export class BackgroundController {
  private readonly local = new ChromeJsonStorageArea(chrome.storage.local);
  private readonly session = new ChromeJsonStorageArea(chrome.storage.session);
  private readonly vault = new CredentialVault(
    this.local,
    new IndexedDbCryptoKeyStore(),
    chrome.runtime.id,
  );
  private readonly preferences = new PreferencesStore(this.local);
  private readonly researchCache = new EvidenceCache();
  private readonly artifactStore = new IndexedDbAnalysisArtifactStore();
  private readonly history = new EncryptedAnalysisHistoryStore(
    new IndexedDbEncryptedAnalysisHistoryVault(this.vault),
  );
  private readonly jobs = new JobStore(
    this.local,
    undefined,
    this.history,
    () => this.clearTransientResearch(),
    {
      get: async (jobId) => {
        const value = await this.vault.read("analysis-resume", EncryptedResumeEnvelopeSchema);
        return value?.jobId === jobId ? value.resume : undefined;
      },
      set: async (jobId, resume) => {
        await this.vault.write(
          "analysis-resume",
          EncryptedResumeEnvelopeSchema.parse({ jobId, resume }),
        );
      },
      remove: async (jobId) => {
        const value = await this.vault.read("analysis-resume", EncryptedResumeEnvelopeSchema);
        if (value?.jobId === jobId) await this.vault.remove("analysis-resume");
      },
    },
  );
  private readonly auth = new ChatGptSessionManager(this.session, this.local, this.vault);
  private initialization: Promise<void> | null = null;
  private readonly ports = new Set<chrome.runtime.Port>();
  private resumeInFlight: Promise<void> | null = null;
  private startInFlight: Promise<AnalysisJob> | null = null;

  initialize(): Promise<void> {
    this.initialization ??= restrictExtensionStorage().catch((error: unknown) => {
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  private async pushAuth(): Promise<void> {
    await this.publish({ type: "auth.changed", auth: await this.auth.getState() });
  }

  private async publish(message: unknown): Promise<void> {
    await Promise.allSettled([
      broadcast(message),
      ...Array.from(this.ports, async (port) => {
        try {
          port.postMessage(message);
        } catch {
          this.ports.delete(port);
        }
      }),
    ]);
  }

  private async saveAndPushJob(job: AnalysisJob, resume?: AnalysisResumeData): Promise<void> {
    const parsed = AnalysisJobSchema.parse(job);
    await this.jobs.set(parsed, resume);
    await this.publish({ type: "analysis.jobChanged", job: parsed });
  }

  onConnect(port: chrome.runtime.Port): void {
    if (port.name !== RUNTIME_PORT_NAME || !isSidePanelSender(port.sender ?? {})) return;
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  async getRuntimeState(): Promise<RuntimeState> {
    return {
      runtimeProtocol: PERSPECTICA_RUNTIME_PROTOCOL,
      auth: await this.auth.getState(),
      preferences: await this.preferences.get(),
      activeJob: (await this.jobs.getActive()) ?? null,
      hasExaKey: await this.vault.has("exa"),
    };
  }

  private async cacheScopeFor(provider: SearchProviderKind): Promise<string> {
    if (provider === "chatgpt") {
      const accountId = (await this.auth.getState()).account?.accountId;
      if (!accountId) return "chatgpt:anonymous";
      return `chatgpt:${await this.scopeDigest(accountId)}`;
    }
    if (provider === "free") return "free:public";
    try {
      const credential = await this.vault.readExa();
      if (!credential) return "exa:unconfigured";
      return `exa:${await this.scopeDigest(credential.apiKey)}`;
    } catch {
      return "exa:unconfigured";
    }
  }

  private async scopeDigest(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }

  private async clearTransientResearch(): Promise<void> {
    await Promise.all([this.researchCache.clearAll(), this.artifactStore.clearAll()]);
  }

  private async clearAccountData(): Promise<void> {
    // Cancellation waits for the offscreen runtime to finish its in-flight
    // persistence callback. Clear the active job and journal only after that
    // barrier so a late event cannot recreate account-local report data.
    await Promise.all([this.jobs.clearHistory(), this.jobs.clearActiveData()]);
    // Drop any terminal artifacts still held by an offscreen document that
    // was between its final event and idle-close timer. A closed document
    // cannot issue a late provider/cache write after account cleanup.
    await chrome.offscreen.closeDocument().catch(() => undefined);
    await this.clearTransientResearch();
  }

  private async currentProviderScope(resume: AnalysisResumeData): Promise<string> {
    const current = await this.cacheScopeFor(resume.searchProvider);
    if (!resume.cacheScope || current !== resume.cacheScope) {
      throw new Error("The previous analysis belonged to a different provider session.");
    }
    return current;
  }

  /** Re-dispatch a persisted non-terminal run after a worker/offscreen restart. */
  async resumeActiveJob(): Promise<void> {
    if (this.resumeInFlight) return this.resumeInFlight;
    this.resumeInFlight = (async () => {
      const job = await this.jobs.getActive();
      if (!job || terminal(job.status)) return;
      const resume = await this.jobs.getResume(job.id);
      if (!resume || !job.runToken || resume.runToken !== job.runToken) {
        const failed = await this.jobs.update(job.id, (current) => ({
          ...current,
          status: "failed",
          revision: current.revision + 1,
          updatedAt: now(),
          error: "The previous analysis could not be resumed. Start a new analysis.",
        }));
        if (failed) await this.publish({ type: "analysis.jobChanged", job: failed });
        return;
      }
      try {
        let cacheScope: string;
        try {
          cacheScope = await this.currentProviderScope(resume);
        } catch {
          const failed = await this.jobs.update(job.id, (current) => ({
            ...current,
            status: "failed",
            runToken: null,
            revision: current.revision + 1,
            updatedAt: now(),
            error:
              "The previous analysis belonged to a different provider session. Start a new analysis.",
          }));
          await this.clearTransientResearch();
          if (failed) await this.publish({ type: "analysis.jobChanged", job: failed });
          return;
        }
        await ensureCompatibleOffscreenDocument();
        await chrome.runtime.sendMessage(
          OffscreenCommandSchema.parse({
            type: "offscreen.analysis.start",
            protocol: PERSPECTICA_RUNTIME_PROTOCOL,
            jobId: job.id,
            runToken: resume.runToken,
            initialSequence: job.lastEventSequence,
            request: resume.request,
            searchProvider: resume.searchProvider,
            cacheScope,
          }),
        );
        await this.publish({ type: "analysis.jobChanged", job });
      } catch (error) {
        const failed = await this.jobs.update(job.id, (current) => ({
          ...current,
          status: "failed",
          revision: current.revision + 1,
          updatedAt: now(),
          error: publicError(error, "The analysis runtime could not be resumed."),
        }));
        if (failed) await this.publish({ type: "analysis.jobChanged", job: failed });
      }
    })().finally(() => {
      this.resumeInFlight = null;
    });
    return this.resumeInFlight;
  }

  private async extractActiveArticle(): Promise<{
    tabId: number;
    tabUrl: string;
    article: ReturnType<typeof ArticleDocumentSchema.parse>;
  }> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) {
      throw new Error("Open a news article in this window, then try again.");
    }
    if (!isWebPage(tab.url)) {
      throw new Error("Perspectica can analyze standard web articles, not browser pages.");
    }
    const initialTabUrl = tab.url;

    let results: chrome.scripting.InjectionResult<unknown>[];
    try {
      // Let the scripting API make the authoritative decision because browser
      // pages and other protected surfaces cannot be scripted even with the
      // extension's all-sites host permission.
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [EXTRACTOR_PATH],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      if (
        /cannot access|cannot be scripted|missing host permission|permission|extensions gallery/i.test(
          detail,
        )
      ) {
        throw new Error(
          "Chrome does not allow extensions to read this page. Open a standard web article, then try again.",
          { cause: error },
        );
      }
      throw error;
    }
    const article = ArticleDocumentSchema.parse(results[0]?.result);
    if (article.extraction.articleStatus === "non-article") {
      throw new Error(
        article.extraction.rejectionReason ??
          "This page does not appear to be a news article. Open an article, then try again.",
      );
    }
    const currentTab = await chrome.tabs.get(tab.id);
    if (!isWebPage(currentTab.url) || tabUrlChanged(initialTabUrl, currentTab.url)) {
      throw new Error("The page changed while Perspectica was reading it. Try again.");
    }
    return { tabId: tab.id, tabUrl: currentTab.url, article };
  }

  private async startAnalysisOnce(forceNew = false): Promise<AnalysisJob> {
    await this.auth.getFreshTokens();
    const preferences = await this.preferences.get();
    if (preferences.searchProvider === "exa" && !(await this.vault.has("exa"))) {
      throw new Error("Add an Exa API key in Perspectica settings before analyzing.");
    }
    const { tabId, tabUrl, article } = await this.extractActiveArticle();
    const cacheScope = await this.cacheScopeFor(preferences.searchProvider);
    const analysisConfigFingerprint = createAnalysisConfigFingerprint(preferences, cacheScope);
    // Disconnect can race extraction. Re-check ownership immediately before
    // creating a resumable job so a stale token cannot start a new run.
    await this.auth.getFreshTokens();
    const existing = await this.jobs.getActive();
    if (
      existing &&
      canReuseAnalysisJob(existing, article, tabId, analysisConfigFingerprint, forceNew, tabUrl)
    ) {
      return existing;
    }
    if (existing && !terminal(existing.status)) {
      await this.cancelAnalysis(existing.id);
    }
    const timestamp = now();
    const runToken = crypto.randomUUID();
    const job: AnalysisJob = {
      id: crypto.randomUUID(),
      tabId,
      tabUrl,
      articleFingerprint: article.fingerprint,
      analysisConfigFingerprint,
      status: "analyzing",
      createdAt: timestamp,
      updatedAt: timestamp,
      error: null,
      events: [],
      runToken,
      revision: 0,
      lastEventSequence: 0,
    };
    const resume: AnalysisResumeData = {
      runToken,
      request: {
        article,
        client: { extensionVersion: EXTENSION_VERSION },
        preferences: {
          model: preferences.model,
          reasoningEffort: preferences.reasoningEffort,
          mode: preferences.mode,
          depth: preferences.depth ?? preferences.mode,
        },
      },
      searchProvider: preferences.searchProvider,
      cacheScope,
    };
    const command = OffscreenCommandSchema.parse({
      type: "offscreen.analysis.start",
      protocol: PERSPECTICA_RUNTIME_PROTOCOL,
      jobId: job.id,
      runToken,
      initialSequence: 0,
      request: resume.request,
      searchProvider: preferences.searchProvider,
      cacheScope,
    });
    await this.saveAndPushJob(job, resume);
    try {
      await ensureCompatibleOffscreenDocument();
      await chrome.runtime.sendMessage(command);
    } catch (error) {
      const failed = await this.jobs.update(job.id, (current) => ({
        ...current,
        status: "failed",
        revision: current.revision + 1,
        updatedAt: now(),
        error: publicError(error, "Perspectica could not start the analysis runtime."),
      }));
      if (failed) await this.publish({ type: "analysis.jobChanged", job: failed });
      throw error;
    }
    return job;
  }

  private startAnalysis(forceNew = false): Promise<AnalysisJob> {
    // Serialize starts rather than coalescing them: an explicit retry that
    // arrives during an automatic replay must still create a fresh job.
    const previous = this.startInFlight ?? Promise.resolve<AnalysisJob | undefined>(undefined);
    let operation: Promise<AnalysisJob>;
    operation = previous
      .catch(() => undefined)
      .then(() => this.startAnalysisOnce(forceNew))
      .finally(() => {
        if (this.startInFlight === operation) this.startInFlight = null;
      });
    this.startInFlight = operation;
    return operation;
  }

  private async cancelAnalysis(jobId: string): Promise<AnalysisJob> {
    let token: string | null = null;
    const cancelled = await this.jobs.update(jobId, (current) => {
      if (terminal(current.status)) return current;
      token = current.runToken;
      return {
        ...current,
        status: "cancelled",
        revision: current.revision + 1,
        updatedAt: now(),
        error: null,
      };
    });
    if (!cancelled) throw new Error("That analysis job no longer exists.");
    await this.publish({ type: "analysis.jobChanged", job: cancelled });
    if (!token) return cancelled;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await ensureCompatibleOffscreenDocument();
        await chrome.runtime.sendMessage(
          OffscreenCommandSchema.parse({
            type: "offscreen.analysis.cancel",
            protocol: PERSPECTICA_RUNTIME_PROTOCOL,
            jobId,
            runToken: token,
          }),
        );
        return cancelled;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    // The persisted cancellation is authoritative; a dead/offline offscreen
    // runtime cannot resurrect this run because all late events carry token.
    if (lastError) {
      console.warn("[perspectica] could not deliver cancellation", describeError(lastError));
    }
    return cancelled;
  }

  private async retryAnalysis(
    jobId: string,
    sections: readonly ReportSection[],
  ): Promise<AnalysisJob> {
    const current = await this.jobs.get(jobId);
    if (!current) throw new Error("That analysis job no longer exists.");
    if (current.status !== "partial") {
      throw new Error("Targeted retry is available only for a partial analysis.");
    }
    if (!current.runToken) throw new Error("That analysis job has no resumable run token.");
    const resume = await this.jobs.getResume(jobId);
    if (!resume || resume.runToken !== current.runToken) {
      throw new Error("The bounded retry context is unavailable. Start a new analysis.");
    }
    const cacheScope = await this.currentProviderScope(resume);
    await this.auth.getFreshTokens();
    const retrying = await this.jobs.update(jobId, (job) => {
      if (job.status !== "partial" || job.runToken !== current.runToken) return undefined;
      return {
        ...job,
        status: "analyzing",
        revision: job.revision + 1,
        updatedAt: now(),
        error: null,
      };
    });
    if (!retrying) throw new Error("That analysis job changed before retry could start.");
    await this.publish({ type: "analysis.jobChanged", job: retrying });
    try {
      await ensureCompatibleOffscreenDocument();
      await chrome.runtime.sendMessage(
        OffscreenCommandSchema.parse({
          type: "offscreen.analysis.retry",
          protocol: PERSPECTICA_RUNTIME_PROTOCOL,
          jobId,
          runToken: retrying.runToken,
          initialSequence: retrying.lastEventSequence,
          request: resume.request,
          searchProvider: resume.searchProvider,
          cacheScope,
          sections,
        }),
      );
    } catch (error) {
      const failed = await this.jobs.update(jobId, (job) => ({
        ...job,
        status: "failed",
        revision: job.revision + 1,
        updatedAt: now(),
        error: publicError(error, "Perspectica could not start the bounded section retry."),
      }));
      if (failed) await this.publish({ type: "analysis.jobChanged", job: failed });
      throw error;
    }
    return retrying;
  }

  private async cancelActiveAnalysisForDisconnect(): Promise<void> {
    const active = await this.jobs.getActive();
    if (active && !terminal(active.status)) await this.cancelAnalysis(active.id);
  }

  async handlePublic(request: ExtensionRequest): Promise<ExtensionResponse> {
    try {
      await this.initialize();
      switch (request.type) {
        case "runtime.getState":
          return ok(request.requestId, await this.getRuntimeState());
        case "auth.begin": {
          const preferences = await this.preferences.get();
          await this.preferences.set({ ...preferences, rememberChatGpt: request.remember });
          const device = await this.auth.begin(request.remember);
          await this.pushAuth();
          return ok(request.requestId, device);
        }
        case "auth.getPending":
          return ok(request.requestId, await this.auth.pendingAuthorization());
        case "auth.poll": {
          const previousAccountId = (await this.auth.getState()).account?.accountId ?? null;
          const result = await this.auth.poll();
          if (result.status === "authenticated") {
            const nextAccountId = result.state.account?.accountId ?? null;
            if (previousAccountId && nextAccountId && previousAccountId !== nextAccountId) {
              await this.cancelActiveAnalysisForDisconnect();
              await this.clearAccountData();
            }
            await this.pushAuth();
          }
          return ok(request.requestId, result);
        }
        case "auth.disconnect": {
          await this.cancelActiveAnalysisForDisconnect();
          await this.clearAccountData();
          const state = await this.auth.disconnect();
          await this.publish({ type: "auth.changed", auth: state });
          return ok(request.requestId, state);
        }
        case "auth.listModels": {
          const models = await this.auth.discoverModels();
          await this.pushAuth();
          return ok(request.requestId, models);
        }
        case "preferences.get":
          return ok(request.requestId, await this.preferences.get());
        case "preferences.update":
          await this.preferences.set(request.preferences);
          return ok(request.requestId, request.preferences);
        case "providers.saveExaKey":
          await this.vault.writeExa({ apiKey: request.apiKey });
          await this.clearTransientResearch();
          return ok(request.requestId, { saved: true });
        case "providers.testExaKey":
          await testExaConnection(request.apiKey);
          return ok(request.requestId, { available: true });
        case "providers.clearExaKey":
          await this.vault.remove("exa");
          await this.clearTransientResearch();
          return ok(request.requestId, { removed: true });
        case "providers.test": {
          if (request.provider === "free") {
            return ok(request.requestId, { available: true });
          }
          if (request.provider === "exa") {
            const credential = await this.vault.readExa();
            if (!credential) throw new Error("Add an Exa API key first.");
            await testExaConnection(credential.apiKey);
            return ok(request.requestId, { available: true });
          }
          const models = await this.auth.discoverModels();
          const preferences = await this.preferences.get();
          await ensureCompatibleOffscreenDocument();
          const probe = (await chrome.runtime.sendMessage(
            OffscreenCommandSchema.parse({
              type: "offscreen.providers.test",
              protocol: PERSPECTICA_RUNTIME_PROTOCOL,
              provider: "chatgpt",
              preferences: {
                model: preferences.model,
                reasoningEffort: preferences.reasoningEffort,
                mode: preferences.mode,
                depth: preferences.depth ?? preferences.mode,
              },
            }),
          )) as { ok?: boolean; data?: unknown; error?: string } | undefined;
          if (!probe?.ok) {
            throw new Error(
              probe?.error ?? "ChatGPT web search is not available for this account and model.",
            );
          }
          return ok(request.requestId, { available: true, models, probe: probe.data });
        }
        case "article.preview": {
          const { tabUrl, article } = await this.extractActiveArticle();
          return ok(
            request.requestId,
            ArticlePreviewSchema.parse({
              title: article.title,
              author: article.author,
              publication: article.publication,
              publishedAt: article.publishedAt,
              contentType: article.contentType,
              tabUrl,
              articleFingerprint: article.fingerprint,
            }),
          );
        }
        case "analysis.start":
          return ok(request.requestId, await this.startAnalysis(request.forceNew ?? false));
        case "analysis.retry":
          return ok(request.requestId, await this.retryAnalysis(request.jobId, request.sections));
        case "analysis.getJob": {
          const job = await this.jobs.get(request.jobId);
          if (!job) throw new Error("That analysis job was not found.");
          return ok(request.requestId, job);
        }
        case "analysis.getEventsSince": {
          const job = await this.jobs.get(request.jobId);
          if (!job) throw new Error("That analysis job was not found.");
          const events = await this.jobs.getEventsSince(request.jobId, request.lastSequence);
          return ok(request.requestId, {
            jobId: request.jobId,
            lastSequence: job.lastEventSequence,
            hasMore: events.length > 0 && events.at(-1)!.sequence < job.lastEventSequence,
            events,
            complete: terminal(job.status),
          });
        }
        case "analysis.getLogs": {
          const job = await this.jobs.getActive();
          if (!job) throw new Error("Run an analysis before copying logs.");
          const logs = await this.jobs.getLogs(job.id);
          const events = (await this.jobs.getEventsSince(job.id, 0)).map(
            (envelope) => envelope.event,
          );
          return ok(request.requestId, {
            text: formatAnalysisLogs(job, logs, events),
            entryCount: logs.length,
            jobId: job.id,
          });
        }
        case "analysis.clearLogs": {
          const job = await this.jobs.getActive();
          if (!job) return ok(request.requestId, { removed: false });
          await this.jobs.clearLogs(job.id);
          return ok(request.requestId, { removed: true, jobId: job.id });
        }
        case "research.cache.clear":
          await this.clearTransientResearch();
          return ok(request.requestId, { removed: true });
        case "analysis.cancel":
          return ok(request.requestId, await this.cancelAnalysis(request.jobId));
      }
    } catch (error) {
      return fail(request.requestId, error, "Perspectica could not complete that request.");
    }
  }

  async handleInternal(request: InternalRequest): Promise<ExtensionResponse> {
    try {
      await this.initialize();
      switch (request.type) {
        case "internal.auth.getTokens":
          return ok(request.requestId, await this.auth.getFreshTokens());
        case "internal.providers.getSecret": {
          if (request.provider === "exa") {
            const value = await this.vault.readExa();
            if (!value) throw new Error("Exa is not configured.");
            return ok(request.requestId, value);
          }
          return ok(request.requestId, {});
        }
        case "internal.analysis.event": {
          const committed = await this.jobs.commitEvent({
            jobId: request.jobId,
            runToken: request.runToken,
            sequence: request.sequence,
            event: request.event,
          });
          if (committed.gap) throw new Error("The analysis event sequence contained a gap.");
          if (!committed.accepted || !committed.job || !committed.envelope)
            return ok(request.requestId, {
              ignored: true,
              duplicate: committed.duplicate ?? false,
            });
          await this.publish({ type: "analysis.jobChanged", job: committed.job });
          await this.publish({
            type: "analysis.eventDelta",
            jobId: request.jobId,
            runToken: request.runToken,
            revision: committed.job.revision,
            sequence: request.sequence,
            event: request.event,
          });
          return ok(request.requestId, { accepted: true, revision: committed.job.revision });
        }
        case "internal.analysis.log": {
          const job = await this.jobs.get(request.jobId);
          if (!job || terminal(job.status) || !job.runToken || job.runToken !== request.runToken)
            return ok(request.requestId, { ignored: true });
          await this.jobs.appendLog(request.jobId, request.entry);
          return ok(request.requestId, { accepted: true });
        }
        case "internal.analysis.finished": {
          const updated = await this.jobs.update(request.jobId, (job) => {
            if (
              !job.runToken ||
              job.runToken !== request.runToken ||
              terminal(job.status) ||
              request.sequence <= job.lastEventSequence
            ) {
              return undefined;
            }
            return {
              ...job,
              status: "failed",
              revision: job.revision + 1,
              updatedAt: now(),
              error: "The analysis ended before it produced a completion event. Try again.",
            };
          });
          if (updated) await this.publish({ type: "analysis.jobChanged", job: updated });
          return ok(request.requestId, { accepted: Boolean(updated) });
        }
        case "internal.analysis.failed": {
          const updated = await this.jobs.update(request.jobId, (job) => {
            if (
              !job.runToken ||
              job.runToken !== request.runToken ||
              terminal(job.status) ||
              request.sequence <= job.lastEventSequence
            ) {
              return undefined;
            }
            return {
              ...job,
              status: "failed",
              revision: job.revision + 1,
              updatedAt: now(),
              error: request.error,
            };
          });
          if (updated) await this.publish({ type: "analysis.jobChanged", job: updated });
          return ok(request.requestId, { accepted: Boolean(updated) });
        }
      }
    } catch (error) {
      return fail(
        request.requestId,
        error,
        "The extension runtime could not complete the request.",
      );
    }
  }

  onMessage(
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: ExtensionResponse) => void,
  ): boolean {
    const publicRequest = ExtensionRequestSchema.safeParse(raw);
    if (publicRequest.success) {
      if (!isSidePanelSender(sender)) {
        sendResponse(fail(publicRequest.data.requestId, "Forbidden", "Forbidden.", "forbidden"));
        return false;
      }
      void this.handlePublic(publicRequest.data).then(sendResponse);
      return true;
    }

    const internalRequest = InternalRequestSchema.safeParse(raw);
    if (internalRequest.success) {
      if (!isOffscreenSender(sender)) {
        sendResponse(fail(internalRequest.data.requestId, "Forbidden", "Forbidden.", "forbidden"));
        return false;
      }
      void this.handleInternal(internalRequest.data).then(sendResponse);
      return true;
    }
    return false;
  }
}
