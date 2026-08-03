import { EvidenceBatchSchema, EvidenceCandidateSchema } from "@perspectica/contracts/evidence";
import type {
  EvidenceBatch,
  EvidenceCandidate,
  EvidenceRetriever,
  RetrievalPlan,
} from "@perspectica/contracts/evidence";
import { normalizeCanonicalUrl } from "@perspectica/contracts/url";
import { runPriorityTasksStream, sourceIdFor } from "@perspectica/intelligence";
import type { EvidenceResultCache } from "../storage/evidence-cache";

const GDELT_MIN_INTERVAL_MS = 5_000;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_RESULT_CONTENT = 14_000;
const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_FETCH_URLS = 4;
const MAX_REDIRECTS = 3;

export interface FreeEvidenceDiagnostics {
  missionId: string;
  durationMs: number;
  resultCount: number;
  cacheHit: boolean;
  outcome: "ready" | "failed";
  error?: string;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isPrivateIpLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return true;
  }
  // URL normalizes IPv4-mapped IPv6 literals to forms such as
  // `::ffff:7f00:1`; classify the embedded address before allowing a fetch.
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    const dotted = mapped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    const hex = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const octets = dotted
      ? (dotted.slice(1).map(Number) as [number, number, number, number])
      : hex
        ? ([
            Number.parseInt(hex[1]!, 16) >> 8,
            Number.parseInt(hex[1]!, 16) & 0xff,
            Number.parseInt(hex[2]!, 16) >> 8,
            Number.parseInt(hex[2]!, 16) & 0xff,
          ] as [number, number, number, number])
        : null;
    if (octets && isPrivateIpv4(octets)) return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number) as [number, number, number, number];
  return isPrivateIpv4(octets);
}

function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  if (octets.some((part) => part > 255)) return true;
  return (
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

/** Only public HTTPS pages may become quoteable source-text candidates. */
export function isSafePublisherUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !isPrivateIpLiteral(url.hostname)
    );
  } catch {
    return false;
  }
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : fallback;
}

function boundedTextFromHtml(html: string): string {
  if (typeof DOMParser === "undefined") {
    return html
      .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_RESULT_CONTENT);
  }
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const selector of [
    "script",
    "style",
    "noscript",
    "template",
    "nav",
    "footer",
    "aside",
    "form",
    "[hidden]",
    "[aria-hidden='true']",
    "[inert]",
  ]) {
    document.querySelectorAll(selector).forEach((element) => element.remove());
  }
  const root = document.querySelector("article, main, [role='main']") ?? document.body;
  return [...root.querySelectorAll("h1, h2, h3, p, blockquote")]
    .map((element) => text(element.textContent))
    .filter((paragraph) => paragraph.length >= 40)
    .join("\n\n")
    .slice(0, MAX_RESULT_CONTENT);
}

export async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("The source response is too large to read safely.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The source response did not provide a readable body.");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("The source response is too large to read safely.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function withAbort(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Request timed out.", "TimeoutError")),
    timeoutMs,
  );
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

function publication(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown publication";
  }
}

function sourceType(url: string): EvidenceCandidate["sourceType"] {
  return /\.(?:gov|mil|edu)(?:\.|\/|$)/i.test(url) ||
    /(?:record|filing|bill|data|report|pdf)/i.test(url)
    ? "primary-record"
    : "independent-reporting";
}

function publishedAt(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

interface DiscoveryResult {
  url: string;
  title: string;
  publishedAt: string | null;
  note: string;
}

export class FreeEvidenceRetriever implements EvidenceRetriever {
  private readonly cache = new Map<string, { expiresAt: number; results: EvidenceCandidate[] }>();
  private lastGdeltAt = 0;

  constructor(
    private readonly fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly onDiagnostics?: (diagnostics: FreeEvidenceDiagnostics) => void,
    private readonly persistentCache?: EvidenceResultCache,
  ) {}

  private async delayForGdelt(signal: AbortSignal): Promise<void> {
    const waitMs = Math.max(0, this.lastGdeltAt + GDELT_MIN_INTERVAL_MS - Date.now());
    if (waitMs === 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async gdelt(
    query: string,
    maxResults: number,
    signal: AbortSignal,
  ): Promise<DiscoveryResult[]> {
    await this.delayForGdelt(signal);
    this.lastGdeltAt = Date.now();
    const endpoint = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
    endpoint.searchParams.set("query", query.slice(0, 400));
    endpoint.searchParams.set("mode", "artlist");
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("maxrecords", String(Math.min(10, Math.max(1, maxResults))));
    const timed = withAbort(signal, 15_000);
    try {
      const response = await this.fetchImplementation(endpoint, {
        signal: timed.signal,
        credentials: "omit",
      });
      if (!response.ok) return [];
      const body = (JSON.parse(await readBounded(response)) as { articles?: unknown[] }).articles;
      return (Array.isArray(body) ? body : []).flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const record = raw as Record<string, unknown>;
        const url = normalizeCanonicalUrl(text(record.url));
        if (!url || !isSafePublisherUrl(url)) return [];
        const title = text(record.title, "Untitled source");
        return [
          {
            url,
            title,
            publishedAt: publishedAt(record.seendate),
            note: [title, text(record.seendate), text(record.domain)].filter(Boolean).join(" · "),
          },
        ];
      });
    } catch (error) {
      if (signal.aborted) throw error;
      return [];
    } finally {
      timed.done();
    }
  }

  private async duckDuckGo(query: string, signal: AbortSignal): Promise<DiscoveryResult[]> {
    const endpoint = new URL("https://api.duckduckgo.com/");
    endpoint.searchParams.set("q", query.slice(0, 400));
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("no_html", "1");
    endpoint.searchParams.set("skip_disambig", "1");
    const timed = withAbort(signal, 10_000);
    try {
      const response = await this.fetchImplementation(endpoint, {
        signal: timed.signal,
        credentials: "omit",
      });
      if (!response.ok) return [];
      const body = JSON.parse(await readBounded(response)) as Record<string, unknown>;
      const url = normalizeCanonicalUrl(text(body.AbstractURL));
      const note = text(body.AbstractText);
      if (!url || !note || !isSafePublisherUrl(url)) return [];
      return [
        {
          url,
          title: text(body.Heading, publication(url)),
          publishedAt: null,
          note,
        },
      ];
    } catch (error) {
      if (signal.aborted) throw error;
      return [];
    } finally {
      timed.done();
    }
  }

  private async readPublisher(url: string, signal: AbortSignal): Promise<string | null> {
    if (!isSafePublisherUrl(url)) return null;
    const timed = withAbort(signal, 18_000);
    try {
      let currentUrl = url;
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const response = await this.fetchImplementation(currentUrl, {
          signal: timed.signal,
          credentials: "omit",
          // Validate each Location before issuing the next request. Following
          // redirects automatically would send a request to a private host
          // before the final response URL could be checked.
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          if (redirect === MAX_REDIRECTS) return null;
          const location = response.headers.get("location");
          const nextUrl = location ? normalizeCanonicalUrl(location, currentUrl) : null;
          if (!nextUrl || !isSafePublisherUrl(nextUrl)) return null;
          currentUrl = nextUrl;
          continue;
        }
        const contentType = response.headers.get("content-type")?.toLocaleLowerCase("en-US") ?? "";
        if (!response.ok || !contentType.includes("text/html")) return null;
        const finalUrl = normalizeCanonicalUrl(response.url || currentUrl);
        if (!finalUrl || !isSafePublisherUrl(finalUrl)) return null;
        return boundedTextFromHtml(await readBounded(response));
      }
      return null;
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    } finally {
      timed.done();
    }
  }

  private async searchMission(
    mission: RetrievalPlan["missions"][number],
    plan: RetrievalPlan,
    signal: AbortSignal,
  ): Promise<EvidenceBatch> {
    const startedAt = Date.now();
    const query = mission.queryVariants[0]?.trim() || "independent context";
    const cacheKey = JSON.stringify({
      provider: "free",
      query,
      mission: mission.purpose,
      include: mission.includeDomains,
      exclude: mission.excludeDomains,
    });
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const candidates = cached.results.map((candidate) => ({
        ...candidate,
        missionId: mission.id,
      }));
      return EvidenceBatchSchema.parse({
        missionId: mission.id,
        provider: "free",
        candidates,
        coveredMissionIds: [mission.id],
        status: "completed",
        error: null,
        searched: false,
        cacheHit: true,
        durationMs: Date.now() - startedAt,
      });
    }
    const persisted = await this.persistentCache?.get<unknown[]>(cacheKey);
    const persistedCandidates = (persisted ?? [])
      .map((candidate) => EvidenceCandidateSchema.safeParse(candidate))
      .flatMap((parsed) =>
        parsed.success && parsed.data.provider === "free" ? [parsed.data] : [],
      );
    if (persistedCandidates.length > 0) {
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        results: persistedCandidates,
      });
      const candidates = persistedCandidates.map((candidate) => ({
        ...candidate,
        missionId: mission.id,
      }));
      return EvidenceBatchSchema.parse({
        missionId: mission.id,
        provider: "free",
        candidates,
        coveredMissionIds: [mission.id],
        status: "completed",
        error: null,
        searched: false,
        cacheHit: true,
        durationMs: Date.now() - startedAt,
      });
    }

    const [gdelt, answer] = await Promise.all([
      this.gdelt(query, Math.min(plan.maxSources, 10), signal),
      this.duckDuckGo(query, signal),
    ]);
    const discoveries = [...new Map([...gdelt, ...answer].map((item) => [item.url, item])).values()]
      .filter(
        (item) =>
          !mission.excludeDomains.some((domain) => {
            const host = new URL(item.url).hostname.replace(/^www\./, "");
            const excluded = domain
              .trim()
              .toLocaleLowerCase("en-US")
              .replace(/^www\./, "");
            return host === excluded || host.endsWith(`.${excluded}`);
          }),
      )
      .slice(0, Math.min(MAX_FETCH_URLS, Math.max(1, plan.maxSources)));
    const fetched = await Promise.all(
      discoveries.map(async (item) => ({
        item,
        content: await this.readPublisher(item.url, signal),
      })),
    );
    const candidates = fetched.map(
      ({ item, content }) =>
        ({
          id: sourceIdFor(item.url, "candidate"),
          missionId: mission.id,
          sourceUrl: item.url,
          title: item.title || publication(item.url),
          publication: publication(item.url),
          publishedAt: item.publishedAt,
          sourceType: sourceType(item.url),
          contentKind: content ? ("source-text" as const) : ("search-summary" as const),
          content: (
            content ||
            item.note ||
            `Free discovery returned ${publication(item.url)}.`
          ).slice(0, 20_000),
          discoveryContext: content ? null : item.note || null,
          discoveryExcerpt: content ? content.slice(0, 360) : null,
          providerScore: null,
          provider: "free" as const,
        }) satisfies EvidenceCandidate,
    );
    const parsedCandidates = candidates.flatMap((candidate) => {
      const parsed = EvidenceCandidateSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
    this.cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, results: parsedCandidates });
    await this.persistentCache?.set(cacheKey, parsedCandidates, CACHE_TTL_MS);
    this.onDiagnostics?.({
      missionId: mission.id,
      durationMs: Date.now() - startedAt,
      resultCount: parsedCandidates.length,
      cacheHit: false,
      outcome: "ready",
    });
    return EvidenceBatchSchema.parse({
      missionId: mission.id,
      provider: "free",
      candidates: parsedCandidates,
      coveredMissionIds: [mission.id],
      status: "completed",
      error: null,
      searched: true,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
  }

  async *retrieve(plan: RetrievalPlan, signal: AbortSignal): AsyncIterable<EvidenceBatch> {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(signal.reason);
    if (signal.aborted) abortFromParent();
    else signal.addEventListener("abort", abortFromParent, { once: true });
    const deadlineTimer = setTimeout(
      () =>
        controller.abort(new DOMException("Evidence retrieval deadline reached.", "TimeoutError")),
      Math.max(0, plan.deadlineAt - Date.now()),
    );
    const tasks = [...plan.missions].map((mission) => ({
      priority: mission.priority,
      run: async (): Promise<EvidenceBatch> => {
        const startedAt = Date.now();
        try {
          return await this.searchMission(mission, plan, controller.signal);
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          this.onDiagnostics?.({
            missionId: mission.id,
            durationMs: Date.now() - startedAt,
            resultCount: 0,
            cacheHit: false,
            outcome: "failed",
            error: message,
          });
          return EvidenceBatchSchema.parse({
            missionId: mission.id,
            provider: "free",
            candidates: [],
            coveredMissionIds: [mission.id],
            status: "failed",
            error: message,
            searched: true,
            cacheHit: false,
            durationMs: Date.now() - startedAt,
          });
        }
      },
    }));
    try {
      for await (const batch of runPriorityTasksStream(tasks, plan.maxConcurrency, signal))
        yield batch;
    } finally {
      clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", abortFromParent);
      controller.abort();
    }
  }
}
