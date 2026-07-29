import {
  AnalysisEventSchema,
  ArticleDocumentSchema,
  type AnalysisEvent,
  type AnalysisPreferences,
  type AnalyzeRequest,
  type ArticleDocument,
} from "@perspectica/contracts";

interface ExtractionSuccess {
  ok: true;
  article: unknown;
}

interface ExtractionFailure {
  ok: false;
  error: string;
}

type ExtractionResponse = ExtractionSuccess | ExtractionFailure;

export const apiBaseUrl =
  import.meta.env.WXT_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
export const chatGptAuthBaseUrl = `${apiBaseUrl}/api/chatgpt`;
export const extensionMode = import.meta.env.WXT_PERSPECTICA_MODE === "demo" ? "demo" : "chatgpt";

export const authenticatedApiFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    credentials: "include",
  });

function isWebPage(url: string | undefined): boolean {
  return Boolean(url && (url.startsWith("http://") || url.startsWith("https://")));
}

export async function extractActiveArticle(): Promise<ArticleDocument> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isWebPage(tab.url)) {
    throw new Error("Open a news article in this window, then try again.");
  }

  let response: ExtractionResponse;
  try {
    response = (await chrome.tabs.sendMessage(tab.id, {
      type: "perspectica.extract-article",
    })) as ExtractionResponse;
  } catch {
    throw new Error("Perspectica cannot read this tab yet. Refresh the article and try again.");
  }

  if (!response.ok) throw new Error(response.error);

  const parsed = ArticleDocumentSchema.safeParse(response.article);
  if (!parsed.success) {
    throw new Error("This page did not contain enough structured article text.");
  }
  return parsed.data;
}

export async function streamAnalysis(
  article: ArticleDocument,
  onEvent: (event: AnalysisEvent) => void,
  signal?: AbortSignal,
  preferences?: AnalysisPreferences,
): Promise<void> {
  const payload: AnalyzeRequest = {
    article,
    client: { extensionVersion: "0.1.0" },
    preferences,
  };
  const response = await authenticatedApiFetch(`${apiBaseUrl}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(error?.error ?? `Analysis failed with status ${response.status}.`);
  }
  if (!response.body) throw new Error("The analysis response did not include a stream.");

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(AnalysisEventSchema.parse(JSON.parse(line)));
    }

    if (done) break;
  }

  if (buffer.trim()) {
    onEvent(AnalysisEventSchema.parse(JSON.parse(buffer)));
  }
}
