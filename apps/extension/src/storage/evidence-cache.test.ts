import { describe, expect, it } from "vitest";
import { EvidenceCache } from "./evidence-cache";

describe("EvidenceCache", () => {
  it("isolates identical provider keys by scope", async () => {
    const accountA = new EvidenceCache("chatgpt:account-a");
    const accountB = new EvidenceCache("chatgpt:account-b");

    await accountA.set("same-query", { source: "A" }, 60_000);

    await expect(accountA.get<{ source: string }>("same-query")).resolves.toEqual({ source: "A" });
    await expect(accountB.get("same-query")).resolves.toBeNull();
  });

  it("clears one scope without removing another scope", async () => {
    const accountA = new EvidenceCache("exa:key-a");
    const accountB = new EvidenceCache("exa:key-b");
    await accountA.set("query", "A", 60_000);
    await accountB.set("query", "B", 60_000);

    await accountA.clear();

    await expect(accountA.get("query")).resolves.toBeNull();
    await expect(accountB.get("query")).resolves.toBe("B");
  });

  it("clears all scopes for account disconnect or extension reset", async () => {
    const accountA = new EvidenceCache("chatgpt:account-a");
    const accountB = new EvidenceCache("exa:key-b");
    await accountA.set("query", "A", 60_000);
    await accountB.set("query", "B", 60_000);

    await accountA.clearAll();

    await expect(accountA.get("query")).resolves.toBeNull();
    await expect(accountB.get("query")).resolves.toBeNull();
  });

  it("expires entries", async () => {
    const cache = new EvidenceCache("scope");
    await cache.set("query", "expired", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(cache.get("query")).resolves.toBeNull();
  });
});
