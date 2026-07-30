export function splitStreamChunks(text: string): string[] {
  // Keep whitespace as part of the stream. Splitting only on `\S+` drops
  // leading whitespace and can make streamed copy look like words were
  // concatenated when a model returns newlines or multiple spaces.
  return text.match(/\S+\s*|\s+/g) ?? (text ? [text] : []);
}

export function streamDurationMs(chunkCount: number): number {
  return Math.min(820, Math.max(220, chunkCount * 22));
}

/**
 * Returns a short, human-readable elapsed value for the live progress line.
 * Kept here so progress and streaming copy share the same formatting rules.
 */
export function formatElapsedMs(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return "just started";
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s elapsed`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s elapsed`;
}
