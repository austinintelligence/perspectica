/**
 * Parameters that are commonly added by analytics, affiliate, and social
 * sharing systems. They identify a visit rather than a distinct document and
 * therefore should not create a second source in a works-cited list.
 */
const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref"]);

/**
 * Query parameters that commonly carry credentials, login state, or signed
 * request material. They must never become part of an article identity or a
 * URL sent to an AI/search provider.
 */
const SENSITIVE_PARAMETERS = new Set([
  "access_token",
  "apikey",
  "api_key",
  "auth",
  "authorization",
  "code",
  "credential",
  "id_token",
  "jwt",
  "key",
  "password",
  "passwd",
  "refresh_token",
  "secret",
  "session",
  "session_id",
  "sid",
  "signature",
  "sig",
  "state",
  "token",
]);

const MAX_CANONICAL_URL_LENGTH = 4_096;

/**
 * Return a deterministic HTTP(S) URL suitable for identity and deduplication.
 *
 * The original URL is never mutated. Hash fragments, known tracking
 * parameters, default ports, host casing, and non-root trailing slashes are
 * removed. A base URL may be supplied for relative links extracted from a
 * document. Invalid or non-web URLs return null instead of throwing.
 */
export function normalizeCanonicalUrl(value: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // A URL userinfo component is effectively a Basic-auth credential. Do not
  // silently preserve or normalize it because the value can later be logged,
  // persisted, or included in a model prompt.
  if (url.username || url.password) return null;

  url.hash = "";
  url.hostname = url.hostname.toLocaleLowerCase("en-US");
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLocaleLowerCase("en-US");
    if (
      normalizedKey.startsWith("utm_") ||
      TRACKING_PARAMETERS.has(normalizedKey) ||
      SENSITIVE_PARAMETERS.has(normalizedKey) ||
      normalizedKey.startsWith("x-amz-")
    ) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  const normalized = url.toString();
  return normalized.length <= MAX_CANONICAL_URL_LENGTH ? normalized : null;
}
