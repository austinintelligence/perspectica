import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKeyValueStore } from "./index";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function createStore(now: () => number) {
  const directory = mkdtempSync(join(tmpdir(), "perspectica-storage-"));
  cleanupPaths.push(directory);
  return new SqliteKeyValueStore<{ status: string }>({
    databasePath: join(directory, "sessions.sqlite"),
    now,
  });
}

describe("SqliteKeyValueStore", () => {
  it("persists values across store instances", async () => {
    const now = () => 100;
    const directory = mkdtempSync(join(tmpdir(), "perspectica-storage-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "sessions.sqlite");

    const first = new SqliteKeyValueStore<{ status: string }>({ databasePath, now });
    await first.set("session-1", { status: "authenticated" }, { ttlMs: 10_000 });
    first.close();

    const second = new SqliteKeyValueStore<{ status: string }>({ databasePath, now });
    await expect(second.get("session-1")).resolves.toEqual({ status: "authenticated" });
    second.close();
  });

  it("removes expired values", async () => {
    let clock = 100;
    const store = createStore(() => clock);
    await store.set("session-1", { status: "pending" }, { ttlMs: 50 });

    clock = 151;
    await expect(store.get("session-1")).resolves.toBeUndefined();
    store.close();
  });

  it("upserts and deletes values", async () => {
    const store = createStore(() => 100);
    await store.set("session-1", { status: "pending" });
    await store.set("session-1", { status: "authenticated" });
    await expect(store.get("session-1")).resolves.toEqual({ status: "authenticated" });

    await store.delete("session-1");
    await expect(store.get("session-1")).resolves.toBeUndefined();
    store.close();
  });
});
