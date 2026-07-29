import type { ChatGPTHandler } from "@opencoredev/loginwithchatgpt-server";
import { describe, expect, it } from "vitest";
import { createPerspecticaChatGptAuth, withManuallyExposedModels } from "./chatgpt-auth";

describe("Perspectica ChatGPT auth", () => {
  it("starts unauthenticated without exposing token material", async () => {
    const auth = createPerspecticaChatGptAuth({
      databasePath: ":memory:",
      secret: "perspectica-test-secret-that-is-long-enough",
    });
    const request = new Request("http://localhost:3000/api/chatgpt/session");

    await expect(auth.getSession(request)).resolves.toEqual({ status: "unauthenticated" });
    await expect(auth.dangerouslyGetTokens(request)).rejects.toMatchObject({
      code: "token_export_disabled",
    });
  });

  it("requires an explicit session secret in production", () => {
    const environment = process.env as Record<string, string | undefined>;
    const previousNodeEnv = environment["NODE_ENV"];
    const previousSecret = environment["PERSPECTICA_SESSION_SECRET"];
    environment["NODE_ENV"] = "production";
    delete environment["PERSPECTICA_SESSION_SECRET"];

    try {
      expect(() => createPerspecticaChatGptAuth({ databasePath: ":memory:" })).toThrow(
        "PERSPECTICA_SESSION_SECRET is required in production",
      );
    } finally {
      if (previousNodeEnv === undefined) delete environment["NODE_ENV"];
      else environment["NODE_ENV"] = previousNodeEnv;
      if (previousSecret === undefined) delete environment["PERSPECTICA_SESSION_SECRET"];
      else environment["PERSPECTICA_SESSION_SECRET"] = previousSecret;
    }
  });

  it("merges manually exposed models into server and HTTP model discovery", async () => {
    const base = {
      basePath: "/api/chatgpt",
      handler: async () => Response.json({ models: ["gpt-5.4"] }),
      fetch: async () => Response.json({ models: ["gpt-5.4"] }),
      getModels: async () => ["gpt-5.4"],
    } as unknown as ChatGPTHandler;
    const auth = withManuallyExposedModels(base, ["gpt-5.6-luna"]);
    const request = new Request("http://localhost:3000/api/chatgpt/models");

    await expect(auth.getModels(request)).resolves.toEqual(["gpt-5.4", "gpt-5.6-luna"]);
    await expect(auth.handler(request).then((response) => response.json())).resolves.toEqual({
      models: ["gpt-5.4", "gpt-5.6-luna"],
    });
  });
});
