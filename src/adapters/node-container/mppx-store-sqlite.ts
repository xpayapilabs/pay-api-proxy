import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "mppx/server";
import { Json } from "ox";
import type { MppxStoreHandle } from "../../ports/mppx-store.js";

export function createSqliteMppxStore(databasePath: string): MppxStoreHandle {
  if (databasePath === ":memory:") {
    return { store: Store.memory(), close: () => {} };
  }

  const directory = dirname(databasePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS mppx_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const store = Store.from({
    async get(key: string) {
      const row = db.prepare("SELECT value FROM mppx_store WHERE key = ?").get(key) as { value: string } | undefined;
      return row ? Json.parse(row.value) : null;
    },
    async put(key: string, value: unknown) {
      db.prepare(`
        INSERT INTO mppx_store (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, Json.stringify(value));
    },
    async delete(key: string) {
      db.prepare("DELETE FROM mppx_store WHERE key = ?").run(key);
    },
    async update<result>(
      key: string,
      fn: (current: unknown | null) => Store.Change<unknown, result>
    ): Promise<result> {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT value FROM mppx_store WHERE key = ?").get(key) as { value: string } | undefined;
        const current = row ? Json.parse(row.value) : null;
        const change = fn(current);
        if (change.op === "set") {
          db.prepare(`
            INSERT INTO mppx_store (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(key, Json.stringify(change.value));
        } else if (change.op === "delete") {
          db.prepare("DELETE FROM mppx_store WHERE key = ?").run(key);
        }
        db.exec("COMMIT");
        return change.result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore rollback errors after a failed SQLite statement.
        }
        throw error;
      }
    }
  });

  return {
    store,
    close: () => {
      db.close();
    }
  };
}
