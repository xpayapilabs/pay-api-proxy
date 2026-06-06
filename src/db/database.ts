import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface DatabaseHandle {
  db: DatabaseSync;
  close(): void;
}

export function openDatabase(path: string): DatabaseHandle {
  if (path !== ":memory:") {
    const directory = dirname(path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  return {
    db,
    close: () => db.close()
  };
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      input_tokens_estimate INTEGER NOT NULL,
      max_output_tokens INTEGER NOT NULL,
      max_charge TEXT NOT NULL,
      actual_input_tokens INTEGER,
      actual_output_tokens INTEGER,
      actual_usage_amount TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      request_id TEXT,
      protocol TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      asset_address TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      settlement_tx TEXT,
      status TEXT NOT NULL,
      settlement_verification TEXT NOT NULL DEFAULT 'test',
      prepaid_max_amount TEXT NOT NULL,
      settled_amount TEXT,
      actual_usage_amount TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(credential_hash),
      FOREIGN KEY(request_id) REFERENCES requests(id)
    );

    CREATE TABLE IF NOT EXISTS payment_sessions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      protocol TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      asset_address TEXT NOT NULL,
      settlement_address TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      authorized_max_amount TEXT NOT NULL,
      remaining_authorized_amount TEXT NOT NULL,
      reserved_amount TEXT NOT NULL,
      settled_amount TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      allowed_models TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(credential_hash),
      FOREIGN KEY(payment_id) REFERENCES payments(id)
    );

    CREATE TABLE IF NOT EXISTS payment_reservations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      reserved_amount TEXT NOT NULL,
      actual_amount TEXT,
      released_amount TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      settled_at TEXT,
      UNIQUE(request_id),
      FOREIGN KEY(session_id) REFERENCES payment_sessions(id),
      FOREIGN KEY(request_id) REFERENCES requests(id)
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      payment_id TEXT,
      receipt_json TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      signature TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(request_id) REFERENCES requests(id),
      FOREIGN KEY(payment_id) REFERENCES payments(id)
    );

    CREATE TABLE IF NOT EXISTS audit_calls (
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
    );

    CREATE INDEX IF NOT EXISTS idx_payments_status_created_at ON payments(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_payment_reservations_session_id ON payment_reservations(session_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_api ON audit_calls(api_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_ref ON audit_calls(payment_reference);
    CREATE INDEX IF NOT EXISTS idx_audit_refund ON audit_calls(refund_status, created_at);
  `);

  repairRenamedPaymentsForeignKeys(db);
  migratePaymentsRequestIdNullable(db);
  // The nullable migration can rename tables referenced by existing FKs, so repair both before and after it.
  repairRenamedPaymentsForeignKeys(db);
  migrateAuditCalls(db);
}

function migrateAuditCalls(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(audit_calls)").all() as Array<Record<string, unknown>>)
      .map((row) => String(row.name))
  );
  ensureColumn(db, columns, "completed_at", "completed_at TEXT");
  ensureColumn(db, columns, "route_id", "route_id TEXT");
  ensureColumn(db, columns, "upstream_path", "upstream_path TEXT");
  ensureColumn(db, columns, "payment_verified", "payment_verified INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, columns, "receipt_attached", "receipt_attached INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, columns, "payment_verified_at", "payment_verified_at TEXT");
  ensureColumn(db, columns, "request_price", "request_price TEXT");
  ensureColumn(db, columns, "asset_symbol", "asset_symbol TEXT");
  ensureColumn(db, columns, "asset_address", "asset_address TEXT");
  ensureColumn(db, columns, "asset_decimals", "asset_decimals INTEGER");
  ensureColumn(db, columns, "chain_id", "chain_id INTEGER");
  ensureColumn(db, columns, "refund_status", "refund_status TEXT NOT NULL DEFAULT 'not_applicable'");
  ensureColumn(db, columns, "refund_reason", "refund_reason TEXT");
}

function ensureColumn(
  db: DatabaseSync,
  columns: Set<string>,
  name: string,
  definition: string
): void {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE audit_calls ADD COLUMN ${definition}`);
  columns.add(name);
}

function migratePaymentsRequestIdNullable(db: DatabaseSync): void {
  const requestIdColumn = (db.prepare("PRAGMA table_info(payments)").all() as Array<Record<string, unknown>>)
    .find((column) => column.name === "request_id");
  if (!requestIdColumn || Number(requestIdColumn.notnull) === 0) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA legacy_alter_table = ON");
  try {
    db.exec(`
      ALTER TABLE payments RENAME TO payments_old_request_id_not_null;

      ${PAYMENTS_TABLE_SQL}

      INSERT INTO payments (
        id, request_id, protocol, chain_id, asset_address, credential_type, credential_hash,
        settlement_tx, status, settlement_verification, prepaid_max_amount, settled_amount, actual_usage_amount,
        created_at, updated_at
      )
      SELECT
        id, request_id, protocol, chain_id, asset_address, credential_type, credential_hash,
        settlement_tx, status, settlement_verification, prepaid_max_amount, settled_amount, actual_usage_amount,
        created_at, updated_at
      FROM payments_old_request_id_not_null;

      DROP TABLE payments_old_request_id_not_null;
      CREATE INDEX IF NOT EXISTS idx_payments_status_created_at ON payments(status, created_at);
    `);
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF");
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function repairRenamedPaymentsForeignKeys(db: DatabaseSync): void {
  const brokenTableName = "payments_old_request_id_not_null";
  const paymentSessionsSql = tableSql(db, "payment_sessions");
  const receiptsSql = tableSql(db, "receipts");

  if (!paymentSessionsSql.includes(brokenTableName) && !receiptsSql.includes(brokenTableName)) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA legacy_alter_table = ON");
  try {
    if (paymentSessionsSql.includes(brokenTableName)) {
      db.exec(`
        ALTER TABLE payment_sessions RENAME TO payment_sessions_old_payments_fk;
        ${PAYMENT_SESSIONS_TABLE_SQL}
        INSERT INTO payment_sessions (
          id, customer_id, payment_id, protocol, chain_id, asset_address, settlement_address,
          credential_hash, authorized_max_amount, remaining_authorized_amount, reserved_amount,
          settled_amount, expires_at, allowed_models, status, created_at, updated_at
        )
        SELECT
          id, customer_id, payment_id, protocol, chain_id, asset_address, settlement_address,
          credential_hash, authorized_max_amount, remaining_authorized_amount, reserved_amount,
          settled_amount, expires_at, allowed_models, status, created_at, updated_at
        FROM payment_sessions_old_payments_fk;
        DROP TABLE payment_sessions_old_payments_fk;
      `);
    }

    if (receiptsSql.includes(brokenTableName)) {
      db.exec(`
        ALTER TABLE receipts RENAME TO receipts_old_payments_fk;
        ${RECEIPTS_TABLE_SQL}
        INSERT INTO receipts (
          id, request_id, payment_id, receipt_json, receipt_hash, signature, status, created_at
        )
        SELECT
          id, request_id, payment_id, receipt_json, receipt_hash, signature, status, created_at
        FROM receipts_old_payments_fk;
        DROP TABLE receipts_old_payments_fk;
      `);
    }
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF");
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function tableSql(db: DatabaseSync, tableName: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { sql?: string }
    | undefined;
  return row?.sql ?? "";
}

const PAYMENTS_TABLE_SQL = `
  CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    request_id TEXT,
    protocol TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    asset_address TEXT NOT NULL,
    credential_type TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    settlement_tx TEXT,
    status TEXT NOT NULL,
    settlement_verification TEXT NOT NULL DEFAULT 'test',
    prepaid_max_amount TEXT NOT NULL,
    settled_amount TEXT,
    actual_usage_amount TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(credential_hash),
    FOREIGN KEY(request_id) REFERENCES requests(id)
  );
`;

const PAYMENT_SESSIONS_TABLE_SQL = `
  CREATE TABLE payment_sessions (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    asset_address TEXT NOT NULL,
    settlement_address TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    authorized_max_amount TEXT NOT NULL,
    remaining_authorized_amount TEXT NOT NULL,
    reserved_amount TEXT NOT NULL,
    settled_amount TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    allowed_models TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(credential_hash),
    FOREIGN KEY(payment_id) REFERENCES payments(id)
  );
`;

const RECEIPTS_TABLE_SQL = `
  CREATE TABLE receipts (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    payment_id TEXT,
    receipt_json TEXT NOT NULL,
    receipt_hash TEXT NOT NULL,
    signature TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(request_id) REFERENCES requests(id),
    FOREIGN KEY(payment_id) REFERENCES payments(id)
  );
`;
