import { describe, expect, it } from "vitest";
import { describeError, redactText, redactUrl, serializeRedacted } from "./redaction";

describe("runtime redaction", () => {
  it("redacts bearer credentials, assignments, and URL credentials", () => {
    const value =
      "Bearer abc123 access_token=secret authorization: Bearer another-secret " +
      "https://reader:password@example.com/story?token=query-secret";
    const redacted = redactText(value);

    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("another-secret");
    expect(redacted).not.toContain("reader:password");
    expect(redacted).toContain("https://[redacted-url]");
    expect(redactText("https://example.com/story?token=query-secret&edition=us")).toContain(
      "edition=us",
    );
    expect(redactText('{"access_token":"json-secret"}')).not.toContain("json-secret");
  });

  it("returns canonical safe URLs and rejects opaque values", () => {
    expect(redactUrl("https://example.com/story?token=secret&ref=feed")).toBe(
      "https://example.com/story",
    );
    expect(redactUrl("https://reader:password@example.com/story")).toBe("[redacted URL]");
    expect(redactUrl("not a URL")).toBe("[redacted URL]");
  });

  it("redacts nested secret fields, errors, and long strings", () => {
    const result = serializeRedacted(
      {
        accessToken: "access-secret",
        nested: {
          apiKey: "exa-secret",
          error: new Error("request failed with Bearer sdk-secret"),
        },
        text: "x".repeat(100),
      },
      { maxStringLength: 32, maxOutputLength: 2_000 },
    );

    expect(result).not.toContain("access-secret");
    expect(result).not.toContain("exa-secret");
    expect(result).not.toContain("sdk-secret");
    expect(result).toContain("[redacted]");
    expect(result).toContain("…");
  });

  it("describes errors without exposing credential-shaped values", () => {
    expect(describeError(new Error("refresh_token=hidden"))).toBe("refresh_token=[redacted]");
    expect(describeError(undefined, "fallback")).toBe("fallback");
  });
});
