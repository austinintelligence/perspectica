import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const keyValueEntries = sqliteTable("key_value_entries", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at"),
});

export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined> | T | undefined;
  set(key: string, value: T, options?: { ttlMs?: number }): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export interface SqliteKeyValueStoreOptions {
  databasePath: string;
  now?: () => number;
}

/**
 * Persistent JSON key/value storage with optional TTL.
 *
 * The Login with ChatGPT handler encrypts token material before calling this
 * store, so SQLite only receives the encrypted session envelope.
 */
export class SqliteKeyValueStore<T> implements KeyValueStore<T> {
  private readonly sqlite: Database.Database;
  private readonly db: BetterSQLite3Database;
  private readonly now: () => number;

  constructor(options: SqliteKeyValueStoreOptions) {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.sqlite = new Database(options.databasePath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS key_value_entries (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER
      )
    `);
    this.db = drizzle({ client: this.sqlite });
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<T | undefined> {
    const row = this.db
      .select()
      .from(keyValueEntries)
      .where(eq(keyValueEntries.key, key))
      .all()
      .at(0);

    if (!row) return undefined;
    if (row.expiresAt !== null && row.expiresAt <= this.now()) {
      await this.delete(key);
      return undefined;
    }

    return JSON.parse(row.value) as T;
  }

  async set(key: string, value: T, options: { ttlMs?: number } = {}): Promise<void> {
    const expiresAt = options.ttlMs === undefined ? null : this.now() + Math.max(0, options.ttlMs);
    const serialized = JSON.stringify(value);

    this.db
      .insert(keyValueEntries)
      .values({ key, value: serialized, expiresAt })
      .onConflictDoUpdate({
        target: keyValueEntries.key,
        set: { value: serialized, expiresAt },
      })
      .run();
  }

  async delete(key: string): Promise<void> {
    this.db.delete(keyValueEntries).where(eq(keyValueEntries.key, key)).run();
  }

  close(): void {
    this.sqlite.close();
  }
}
