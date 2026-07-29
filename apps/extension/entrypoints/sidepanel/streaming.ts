export function splitStreamChunks(text: string): string[] {
  return text.match(/\S+\s*/g) ?? (text ? [text] : []);
}

export function streamDurationMs(chunkCount: number): number {
  return Math.min(820, Math.max(220, chunkCount * 22));
}
