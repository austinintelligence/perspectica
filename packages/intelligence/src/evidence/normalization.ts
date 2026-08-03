import { normalizeCanonicalUrl, normalizeEvidenceText } from "@perspectica/contracts/url";

export { normalizeCanonicalUrl, normalizeEvidenceText };

export function sourceIdFor(url: string, provider: string): string {
  const canonical = normalizeCanonicalUrl(url) ?? url;
  let hash = 0x811c9dc5;
  const value = `${provider}:${canonical}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `source-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function assertionIdFor(sourceId: string, missionId: string, statement: string): string {
  let hash = 0x811c9dc5;
  const value = `${sourceId}:${missionId}:${normalizeEvidenceText(statement)}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `evidence-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function contentSignature(content: string): string {
  const normalized = normalizeEvidenceText(content).toLocaleLowerCase("en-US");
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `content-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function excerptMatchesContent(excerpt: string, content: string): boolean {
  const normalizedExcerpt = normalizeEvidenceText(excerpt);
  if (!normalizedExcerpt) return false;
  return normalizeEvidenceText(content).includes(normalizedExcerpt);
}
