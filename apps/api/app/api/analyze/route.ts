import { runAnalysis } from "@perspectica/analysis";
import { AnalyzeRequestSchema, type AnalysisEvent } from "@perspectica/contracts";
import {
  ChatGptConnectionRequiredError,
  createAnalysisDependencies,
} from "../../../lib/analysis-dependencies";
import { corsPreflight, withExtensionCors } from "../../../lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 2_000_000;

const METHODS = "POST, OPTIONS";

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, METHODS);
}

function jsonError(request: Request, body: unknown, status: number): Response {
  return withExtensionCors(request, Response.json(body, { status }), METHODS);
}

function eventDiagnostics(event: AnalysisEvent): string {
  switch (event.type) {
    case "compass.provisional":
    case "compass.ready":
      return ` label=${event.data.label} basis=${event.data.basis} confidence=${event.data.confidenceScore}`;
    case "bias.ready":
      return ` status=${event.data.status} findings=${event.data.findings.length}`;
    case "journalistContext.ready":
      return ` status=${event.data.status} findings=${event.data.findings.length} emptyReason=${event.data.emptyReason ?? "none"}`;
    case "supporting.ready":
    case "contradicting.ready":
    case "additionalContext.ready":
      return ` status=${event.data.status} sources=${event.data.sources.length} emptyReason=${event.data.emptyReason ?? "none"}`;
    case "sourceList.ready":
      return ` status=${event.data.status} sources=${event.data.sources.length}`;
    case "analysis.completed":
      return ` status=${event.data.status} failedSections=${event.data.failedSections.join(",") || "none"}`;
    default:
      return "";
  }
}

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return jsonError(request, { error: "The extracted article is too large to analyze." }, 413);
  }

  const encoder = new TextEncoder();
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonError(request, { error: "The request body could not be read." }, 400);
  }
  if (encoder.encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
    return jsonError(request, { error: "The extracted article is too large to analyze." }, 413);
  }

  let input: unknown;
  try {
    input = JSON.parse(rawBody);
  } catch {
    return jsonError(request, { error: "The request body must be valid JSON." }, 400);
  }

  const parsed = AnalyzeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return jsonError(
      request,
      {
        error: "The extracted article did not match the analysis contract.",
        issues: parsed.error.issues,
      },
      422,
    );
  }

  let dependencies;
  try {
    dependencies = await createAnalysisDependencies(request, parsed.data.preferences);
  } catch (error) {
    const status = error instanceof ChatGptConnectionRequiredError ? error.status : 502;
    return jsonError(
      request,
      {
        error:
          error instanceof Error
            ? error.message
            : "Perspectica could not start the ChatGPT analysis.",
      },
      status,
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const requestStartedAt = Date.now();
      try {
        const events = runAnalysis(parsed.data, dependencies, request.signal);

        for await (const event of events) {
          if (event.type === "analysis.started") {
            console.info(
              `[perspectica] analysis=${event.analysisId} model=${event.data.modelVersion} reasoning=${event.data.reasoningEffort} started`,
            );
          } else if (
            event.type.endsWith(".ready") ||
            event.type === "compass.provisional" ||
            event.type === "section.failed" ||
            event.type === "analysis.completed"
          ) {
            const section = event.type === "section.failed" ? event.data.section : event.type;
            const elapsed = Date.now() - requestStartedAt;
            if (event.type === "section.failed") {
              const message = event.data.message.replace(/\s+/g, " ").slice(0, 400);
              console.error(
                `[perspectica] analysis=${event.analysisId} section=${section} elapsedMs=${elapsed} error=${JSON.stringify(message)}`,
              );
            } else {
              console.info(
                `[perspectica] analysis=${event.analysisId} section=${section} elapsedMs=${elapsed}${eventDiagnostics(event)}`,
              );
            }
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      } catch (error) {
        if (request.signal.aborted) {
          controller.close();
          return;
        }
        controller.error(error);
      }
    },
    cancel() {
      // The incoming Request signal is cancelled by the runtime when the client disconnects.
    },
  });

  return withExtensionCors(
    request,
    new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    }),
    METHODS,
  );
}
