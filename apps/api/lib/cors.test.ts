import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTENSION_ORIGIN,
  corsPreflight,
  isAllowedBrowserOrigin,
  withExtensionCors,
} from "./cors";

describe("extension CORS", () => {
  it("allows the configured extension with credentials", () => {
    const request = new Request("http://localhost:3000/api/chatgpt/session", {
      headers: { origin: DEFAULT_EXTENSION_ORIGIN },
    });
    const response = withExtensionCors(request, Response.json({ status: "ok" }), "GET");

    expect(response.headers.get("access-control-allow-origin")).toBe(DEFAULT_EXTENSION_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does not reflect untrusted origins", () => {
    const request = new Request("http://localhost:3000/api/chatgpt/session", {
      headers: { origin: "https://attacker.example" },
    });
    const response = withExtensionCors(request, Response.json({ status: "ok" }), "GET");

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(isAllowedBrowserOrigin(request)).toBe(false);
    expect(corsPreflight(request, "GET").status).toBe(403);
  });
});
