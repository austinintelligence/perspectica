import { normalizeCanonicalUrl } from "./canonical-url";

export { normalizeCanonicalUrl } from "./canonical-url";

export function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function sameCanonicalUrl(left: string, right: string): boolean {
  const leftUrl = normalizeCanonicalUrl(left);
  const rightUrl = normalizeCanonicalUrl(right);
  return leftUrl !== null && leftUrl === rightUrl;
}
