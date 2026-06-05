import { Store } from "mppx/server";
import { Json } from "ox";
import type { MppxStoreHandle } from "../../ports/mppx-store.js";

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface DurableObjectStubLike {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export function mppxStoreStub(
  namespace: DurableObjectNamespaceLike,
  name = "mppx-store"
): DurableObjectStubLike {
  return namespace.get(namespace.idFromName(name));
}

export function createDurableObjectMppxStore(
  namespace: DurableObjectNamespaceLike,
  name = "mppx-store"
): MppxStoreHandle {
  const stub = mppxStoreStub(namespace, name);
  const store = Store.from({
    async get(key) {
      const response = await stub.fetch(`https://mppx-store.local/store/${encodeURIComponent(key)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`mppx Durable Object get failed: ${response.status}`);
      return Json.parse(await response.text()) as never;
    },
    async put(key, value) {
      const response = await stub.fetch(`https://mppx-store.local/store/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: Json.stringify(value)
      });
      if (!response.ok) throw new Error(`mppx Durable Object put failed: ${response.status}`);
    },
    async delete(key) {
      const response = await stub.fetch(`https://mppx-store.local/store/${encodeURIComponent(key)}`, {
        method: "DELETE"
      });
      if (!response.ok) throw new Error(`mppx Durable Object delete failed: ${response.status}`);
    },
    async update<result>(
      key: string,
      fn: (current: unknown | null) => Store.Change<unknown, result>
    ): Promise<result> {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const snapshot = await readSnapshot(stub, key);
        const current = snapshot.value === null ? null : Json.parse(snapshot.value);
        const change = fn(current as never);
        const commit = await stub.fetch(`https://mppx-store.local/store/${encodeURIComponent(key)}/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: snapshot.version,
            op: change.op,
            value: change.op === "set" ? Json.stringify(change.value) : undefined
          })
        });
        if (commit.status === 409) continue;
        if (!commit.ok) throw new Error(`mppx Durable Object update commit failed: ${commit.status}`);
        return change.result;
      }
      throw new Error(`mppx Durable Object update conflict for key ${key}`);
    }
  });

  return {
    store,
    close: () => {}
  };
}

async function readSnapshot(
  stub: DurableObjectStubLike,
  key: string
): Promise<{ value: string | null; version: number }> {
  const response = await stub.fetch(`https://mppx-store.local/store/${encodeURIComponent(key)}/snapshot`);
  if (!response.ok) throw new Error(`mppx Durable Object snapshot failed: ${response.status}`);
  return response.json() as Promise<{ value: string | null; version: number }>;
}

type SqlStorageLike = {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
};

type DurableObjectStateLike = {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    sql: SqlStorageLike;
  };
};

interface AuditRow {
  id: string;
  created_at: string;
  api_id: string | null;
  method: string;
  path: string;
  status: number;
  paid: number;
  payment_method: string | null;
  payment_reference: string | null;
  external_id: string | null;
  receipt_timestamp: string | null;
  duration_ms: number | null;
}

const AUDIT_MAX_LIMIT = 1000;
const AUDIT_DEFAULT_LIMIT = 100;

export class MppxStoreDurableObject {
  private auditSchemaReady = false;

  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/audit") return this.handleAudit(request, url);
    const match = /^\/store\/([^/]+)(?:\/(snapshot|commit))?$/.exec(url.pathname);
    if (!match) return new Response("Not Found", { status: 404 });

    const key = decodeURIComponent(match[1]!);
    const action = match[2];

    if (request.method === "GET" && !action) {
      const value = await this.state.storage.get<string>(key);
      return value === undefined ? new Response(null, { status: 404 }) : new Response(value);
    }

    if (request.method === "PUT" && !action) {
      await this.state.storage.put(key, await request.text());
      await this.incrementVersion(key);
      return new Response(null, { status: 204 });
    }

    if (request.method === "DELETE" && !action) {
      await this.state.storage.delete(key);
      await this.incrementVersion(key);
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && action === "snapshot") {
      const [value, version] = await Promise.all([
        this.state.storage.get<string>(key),
        this.version(key)
      ]);
      return Response.json({ value: value ?? null, version });
    }

    if (request.method === "POST" && action === "commit") {
      const change = await request.json() as { expectedVersion?: unknown; op?: unknown; value?: unknown };
      const version = await this.version(key);
      if (change.expectedVersion !== version) {
        return new Response("Version conflict", { status: 409 });
      }
      if (change.op === "set") {
        if (typeof change.value !== "string") {
          return new Response("Invalid set value", { status: 400 });
        }
        await this.state.storage.put(key, change.value);
      } else if (change.op === "delete") {
        await this.state.storage.delete(key);
      } else if (change.op !== "noop") {
        return new Response("Invalid operation", { status: 400 });
      }
      if (change.op !== "noop") await this.setVersion(key, version + 1);
      return new Response(null, { status: 204 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  private async version(key: string): Promise<number> {
    const value = await this.state.storage.get<number>(this.versionKey(key));
    return typeof value === "number" ? value : 0;
  }

  private async setVersion(key: string, version: number): Promise<void> {
    await this.state.storage.put(this.versionKey(key), version);
  }

  private async incrementVersion(key: string): Promise<void> {
    await this.setVersion(key, (await this.version(key)) + 1);
  }

  private versionKey(key: string): string {
    return `__version:${key}`;
  }

  private ensureAuditSchema(): void {
    if (this.auditSchemaReady) return;
    const sql = this.state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS audit_calls (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      api_id TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      paid INTEGER NOT NULL,
      payment_method TEXT,
      payment_reference TEXT,
      external_id TEXT,
      receipt_timestamp TEXT,
      duration_ms INTEGER
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_calls(created_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_audit_api ON audit_calls(api_id, created_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_audit_ref ON audit_calls(payment_reference)");
    this.auditSchemaReady = true;
  }

  private async handleAudit(request: Request, url: URL): Promise<Response> {
    this.ensureAuditSchema();
    if (request.method === "POST") {
      const entry = await request.json() as Record<string, unknown>;
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO audit_calls
         (id, created_at, api_id, method, path, status, paid,
          payment_method, payment_reference, external_id, receipt_timestamp, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(entry.id),
        String(entry.createdAt),
        entry.apiId ?? null,
        String(entry.method),
        String(entry.path),
        Number(entry.status),
        entry.paid ? 1 : 0,
        entry.paymentMethod ?? null,
        entry.paymentReference ?? null,
        entry.externalId ?? null,
        entry.receiptTimestamp ?? null,
        entry.durationMs ?? null
      );
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET") {
      const clauses: string[] = [];
      const bindings: unknown[] = [];
      const since = url.searchParams.get("since");
      const apiId = url.searchParams.get("apiId");
      const reference = url.searchParams.get("reference");
      if (since) { clauses.push("created_at >= ?"); bindings.push(since); }
      if (apiId) { clauses.push("api_id = ?"); bindings.push(apiId); }
      if (reference) { clauses.push("payment_reference = ?"); bindings.push(reference); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = clampAuditLimit(url.searchParams.get("limit"));
      const rows = this.state.storage.sql.exec<AuditRow>(
        `SELECT * FROM audit_calls ${where} ORDER BY created_at DESC LIMIT ?`,
        ...bindings,
        limit
      ).toArray();
      return Response.json(rows.map(auditRowToJson));
    }

    return new Response("Method Not Allowed", { status: 405 });
  }
}

function clampAuditLimit(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return AUDIT_DEFAULT_LIMIT;
  return Math.min(Math.floor(value), AUDIT_MAX_LIMIT);
}

function auditRowToJson(row: AuditRow): Record<string, unknown> {
  return {
    id: row.id,
    createdAt: row.created_at,
    apiId: row.api_id ?? undefined,
    method: row.method,
    path: row.path,
    status: row.status,
    paid: row.paid === 1,
    paymentMethod: row.payment_method ?? undefined,
    paymentReference: row.payment_reference ?? undefined,
    externalId: row.external_id ?? undefined,
    receiptTimestamp: row.receipt_timestamp ?? undefined,
    durationMs: row.duration_ms ?? undefined
  };
}
