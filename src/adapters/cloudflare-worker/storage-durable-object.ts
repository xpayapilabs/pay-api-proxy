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
  completed_at: string | null;
  api_id: string | null;
  route_id: string | null;
  method: string;
  path: string;
  upstream_path: string | null;
  status: number;
  paid: number;
  payment_verified: number;
  receipt_attached: number;
  payment_method: string | null;
  payment_reference: string | null;
  external_id: string | null;
  receipt_timestamp: string | null;
  payment_verified_at: string | null;
  request_price: string | null;
  asset_symbol: string | null;
  asset_address: string | null;
  asset_decimals: number | null;
  chain_id: number | null;
  refund_status: string;
  refund_reason: string | null;
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
      completed_at TEXT,
      api_id TEXT,
      route_id TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      upstream_path TEXT,
      status INTEGER NOT NULL,
      paid INTEGER NOT NULL,
      payment_verified INTEGER NOT NULL DEFAULT 0,
      receipt_attached INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT,
      payment_reference TEXT,
      external_id TEXT,
      receipt_timestamp TEXT,
      payment_verified_at TEXT,
      request_price TEXT,
      asset_symbol TEXT,
      asset_address TEXT,
      asset_decimals INTEGER,
      chain_id INTEGER,
      refund_status TEXT NOT NULL DEFAULT 'not_applicable',
      refund_reason TEXT,
      duration_ms INTEGER
    )`);
    const columns = new Set(
      sql.exec<{ name: string }>("PRAGMA table_info(audit_calls)")
        .toArray()
        .map((row) => String(row.name))
    );
    ensureAuditColumn(sql, columns, "completed_at", "completed_at TEXT");
    ensureAuditColumn(sql, columns, "route_id", "route_id TEXT");
    ensureAuditColumn(sql, columns, "upstream_path", "upstream_path TEXT");
    ensureAuditColumn(sql, columns, "payment_verified", "payment_verified INTEGER NOT NULL DEFAULT 0");
    ensureAuditColumn(sql, columns, "receipt_attached", "receipt_attached INTEGER NOT NULL DEFAULT 0");
    ensureAuditColumn(sql, columns, "payment_verified_at", "payment_verified_at TEXT");
    ensureAuditColumn(sql, columns, "request_price", "request_price TEXT");
    ensureAuditColumn(sql, columns, "asset_symbol", "asset_symbol TEXT");
    ensureAuditColumn(sql, columns, "asset_address", "asset_address TEXT");
    ensureAuditColumn(sql, columns, "asset_decimals", "asset_decimals INTEGER");
    ensureAuditColumn(sql, columns, "chain_id", "chain_id INTEGER");
    ensureAuditColumn(sql, columns, "refund_status", "refund_status TEXT NOT NULL DEFAULT 'not_applicable'");
    ensureAuditColumn(sql, columns, "refund_reason", "refund_reason TEXT");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_calls(created_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_audit_api ON audit_calls(api_id, created_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_audit_ref ON audit_calls(payment_reference)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_audit_refund ON audit_calls(refund_status, created_at)");
    this.auditSchemaReady = true;
  }

  private async handleAudit(request: Request, url: URL): Promise<Response> {
    this.ensureAuditSchema();
    if (request.method === "POST") {
      const entry = await request.json() as Record<string, unknown>;
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO audit_calls
         (id, created_at, completed_at, api_id, route_id, method, path, upstream_path,
          status, paid, payment_verified, receipt_attached,
          payment_method, payment_reference, external_id, receipt_timestamp, payment_verified_at,
          request_price, asset_symbol, asset_address, asset_decimals, chain_id,
          refund_status, refund_reason, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(entry.id),
        String(entry.createdAt),
        entry.completedAt ?? null,
        entry.apiId ?? null,
        entry.routeId ?? null,
        String(entry.method),
        String(entry.path),
        entry.upstreamPath ?? null,
        Number(entry.status),
        entry.paid ? 1 : 0,
        entry.paymentVerified ? 1 : 0,
        entry.receiptAttached ? 1 : 0,
        entry.paymentMethod ?? null,
        entry.paymentReference ?? null,
        entry.externalId ?? null,
        entry.receiptTimestamp ?? null,
        entry.paymentVerifiedAt ?? null,
        entry.requestPrice ?? null,
        entry.assetSymbol ?? null,
        entry.assetAddress ?? null,
        entry.assetDecimals ?? null,
        entry.chainId ?? null,
        entry.refundStatus ?? "not_applicable",
        entry.refundReason ?? null,
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
      const refundStatus = url.searchParams.get("refundStatus");
      if (since) { clauses.push("created_at >= ?"); bindings.push(since); }
      if (apiId) { clauses.push("api_id = ?"); bindings.push(apiId); }
      if (reference) { clauses.push("payment_reference = ?"); bindings.push(reference); }
      if (refundStatus) { clauses.push("refund_status = ?"); bindings.push(refundStatus); }
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

function ensureAuditColumn(
  sql: SqlStorageLike,
  columns: Set<string>,
  name: string,
  definition: string
): void {
  if (columns.has(name)) return;
  sql.exec(`ALTER TABLE audit_calls ADD COLUMN ${definition}`);
  columns.add(name);
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
    completedAt: row.completed_at ?? undefined,
    apiId: row.api_id ?? undefined,
    routeId: row.route_id ?? undefined,
    method: row.method,
    path: row.path,
    upstreamPath: row.upstream_path ?? undefined,
    status: row.status,
    paid: row.paid === 1,
    paymentVerified: row.payment_verified === 1,
    receiptAttached: row.receipt_attached === 1,
    paymentMethod: row.payment_method ?? undefined,
    paymentReference: row.payment_reference ?? undefined,
    externalId: row.external_id ?? undefined,
    receiptTimestamp: row.receipt_timestamp ?? undefined,
    paymentVerifiedAt: row.payment_verified_at ?? undefined,
    requestPrice: row.request_price ?? undefined,
    assetSymbol: row.asset_symbol ?? undefined,
    assetAddress: row.asset_address ?? undefined,
    assetDecimals: row.asset_decimals ?? undefined,
    chainId: row.chain_id ?? undefined,
    refundStatus: row.refund_status,
    refundReason: row.refund_reason ?? undefined,
    durationMs: row.duration_ms ?? undefined
  };
}
