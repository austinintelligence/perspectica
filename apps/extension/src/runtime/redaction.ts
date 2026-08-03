import { normalizeCanonicalUrl } from "@perspectica/contracts";

const SENSITIVE_FIELD_PATTERN =
  /^(?:access|refresh|id)[-_ ]?token$|^(?:api[-_ ]?key|x-api-key)$|^(?:authorization|cookie|set-cookie|password|passwd|secret|credential|client[-_ ]?secret|private[-_ ]?key|session(?:[-_ ]?id)?|jwt|token|code)$/i;

const SENSITIVE_ASSIGNMENT_PATTERN =
  /((?:["']?(?:(?:access|refresh|id)[-_ ]?token|api[-_ ]?key|x-api-key|authorization|cookie|set-cookie|password|passwd|secret|credential|client[-_ ]?secret|private[-_ ]?key|session(?:[-_ ]?id)?|jwt|token|code)["']?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

const BEARER_PATTERN = /\bBearer\s+[^\s,;}]+/gi;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

export interface RedactionOptions {
  maxStringLength?: number;
  maxOutputLength?: number;
}

function redactUrlToken(value: string): string {
  const trailing = value.match(/[),.;!?]+$/)?.[0] ?? "";
  const candidate = trailing ? value.slice(0, -trailing.length) : value;
  const normalized = normalizeCanonicalUrl(candidate);
  return `${normalized ?? "https://[redacted-url]"}${trailing}`;
}

function redactDiagnosticText(value: string): string {
  return redactText(value).replace(URL_PATTERN, (url) => {
    const trailing = url.match(/[),.;!?]+$/)?.[0] ?? "";
    const candidate = trailing ? url.slice(0, -trailing.length) : url;
    return `${redactUrl(candidate)}${trailing}`;
  });
}

/** Redacts secrets, credentials, and sensitive URL material from free text. */
export function redactText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(URL_PATTERN, (url) => redactUrlToken(url))
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1[redacted]");
}

/**
 * Returns a safe representation of an arbitrary URL for diagnostics. Invalid
 * or non-web URLs are not copied into telemetry because they may be opaque
 * credential-bearing values.
 */
export function redactUrl(value: string): string {
  const normalized = normalizeCanonicalUrl(value);
  if (!normalized) return "[redacted URL]";
  try {
    const url = new URL(normalized);
    // Diagnostic URLs never need query state. Even a currently-benign query
    // can become a credential or signed request after a provider redirect.
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted URL]";
  }
}

function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELD_PATTERN.test(key);
}

/**
 * Serializes diagnostic data while applying the same redaction policy to
 * nested values, Error objects, URLs, and secret-shaped field names.
 */
export function serializeRedacted(
  value: unknown,
  { maxStringLength = 4_000, maxOutputLength = 12_000 }: RedactionOptions = {},
): string | null {
  if (value === undefined || value === null) return null;
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(
      value,
      (key, item: unknown) => {
        if (key && isSensitiveField(key)) return "[redacted]";
        if (item instanceof Error) {
          return {
            name: item.name,
            message: redactDiagnosticText(item.message),
            stack: item.stack ? redactDiagnosticText(item.stack) : undefined,
            cause: item.cause,
          };
        }
        if (typeof item === "string") {
          const redacted = redactDiagnosticText(item);
          return redacted.length > maxStringLength
            ? `${redacted.slice(0, maxStringLength - 1)}…`
            : redacted;
        }
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) return "[circular]";
          seen.add(item);
        }
        return item;
      },
      2,
    );
  } catch (error) {
    serialized = JSON.stringify({
      serializationError: redactDiagnosticText(
        error instanceof Error ? error.message : String(error),
      ),
      value: redactDiagnosticText(String(value)),
    });
  }
  return redactDiagnosticText(serialized).slice(0, maxOutputLength);
}

export function describeError(error: unknown, fallback = "Unknown error"): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const safe = redactText(message).trim();
  return (safe || fallback).slice(0, 1_000);
}
