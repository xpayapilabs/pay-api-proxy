import { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "../../src/db/database.js";
import { Repository } from "../../src/db/repository.js";

describe("repository", () => {
  it("migrates older payments tables so session funding payments do not need request_id", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE requests (
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

      CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
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
    `);

    migrate(db);

    const requestIdColumn = (db.prepare("PRAGMA table_info(payments)").all() as Array<Record<string, unknown>>)
      .find((column) => column.name === "request_id");
    expect(Number(requestIdColumn?.notnull)).toBe(0);

    const repository = new Repository(db);
    const payment = repository.createPayment({
      id: "pay_session_funding",
      protocol: "mpp",
      chainId: 42431,
      assetAddress: "0xasset",
      credentialType: "transaction",
      credentialHash: "hash_session_funding",
      status: "settled",
      settlementVerification: "test",
      prepaidMaxAmount: "100000",
      settledAmount: "100000"
    });
    expect(payment.requestId).toBeUndefined();
    expect(repository.getPayment("pay_session_funding")?.requestId).toBeUndefined();
    db.close();
  });

  it("repairs dependent tables that reference a temporary payments migration table", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE requests (
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
        FOREIGN KEY(payment_id) REFERENCES "payments_old_request_id_not_null"(id)
      );

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
        FOREIGN KEY(payment_id) REFERENCES "payments_old_request_id_not_null"(id)
      );
    `);

    migrate(db);

    const sessionFk = db.prepare("PRAGMA foreign_key_list(payment_sessions)").all() as Array<Record<string, unknown>>;
    const receiptFk = db.prepare("PRAGMA foreign_key_list(receipts)").all() as Array<Record<string, unknown>>;
    expect(sessionFk.some((fk) => fk.table === "payments")).toBe(true);
    expect(receiptFk.some((fk) => fk.table === "payments")).toBe(true);

    const repository = new Repository(db);
    const payment = repository.createPayment({
      id: "pay_repaired_session",
      protocol: "mpp",
      chainId: 42431,
      assetAddress: "0xasset",
      credentialType: "transaction",
      credentialHash: "hash_repaired_session",
      status: "settled",
      settlementVerification: "test",
      prepaidMaxAmount: "100000",
      settledAmount: "100000"
    });
    repository.createPaymentSession({
      id: "sess_repaired",
      customerId: "cust_repaired",
      paymentId: payment.id,
      protocol: "mpp",
      chainId: 42431,
      assetAddress: "0xasset",
      settlementAddress: "0xsettlement",
      credentialHash: "hash_repaired_session",
      authorizedMaxAmount: "100000",
      remainingAuthorizedAmount: "100000",
      reservedAmount: "0",
      settledAmount: "0",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedModels: ["test-chat"],
      status: "active"
    });
    expect(repository.getPaymentSession("sess_repaired")?.paymentId).toBe(payment.id);
    db.close();
  });

  it("persists request, payment, and receipt records", () => {
    const database = openDatabase(":memory:");
    const repository = new Repository(database.db);

    repository.createRequest({
      id: "req_repo",
      model: "test-chat",
      status: "running",
      inputTokensEstimate: 10,
      maxOutputTokens: 20,
      maxCharge: "1000"
    });
    repository.completeRequest("req_repo", 10, 4, "500");

    repository.createPayment({
      id: "pay_repo",
      requestId: "req_repo",
      protocol: "mpp",
      chainId: 42431,
      assetAddress: "0xasset",
      credentialType: "transaction",
      credentialHash: "hash_repo",
      settlementTx: "tx_repo",
      status: "settled",
      settlementVerification: "test",
      prepaidMaxAmount: "1000",
      settledAmount: "1000"
    });

    repository.createReceipt({
      id: "rcpt_repo",
      requestId: "req_repo",
      paymentId: "pay_repo",
      receiptJson: "{}",
      receiptHash: "receipt_hash",
      signature: "sig",
      status: "final"
    });

    expect(repository.getRequest("req_repo")?.actualUsageAmount).toBe("500");
    expect(repository.findPaymentByCredentialHash("hash_repo")?.id).toBe("pay_repo");
    expect(repository.getReceipt("rcpt_repo")?.status).toBe("final");
    database.close();
  });

  it("reserves, settles, releases, and protects payment sessions", () => {
    const database = openDatabase(":memory:");
    const repository = new Repository(database.db);

    repository.createPayment({
      id: "pay_session",
      protocol: "mpp",
      chainId: 42431,
      assetAddress: "0xasset",
      credentialType: "transaction",
      credentialHash: "hash_session",
      status: "settled",
      settlementVerification: "test",
      prepaidMaxAmount: "1000",
      settledAmount: "1000"
    });
    repository.createPaymentSession({
      id: "sess_repo",
      customerId: "cust_repo",
      paymentId: "pay_session",
      protocol: "mpp",
      chainId: 42431,
      assetAddress: "0xasset",
      settlementAddress: "0xsettlement",
      credentialHash: "hash_session",
      authorizedMaxAmount: "1000",
      remainingAuthorizedAmount: "1000",
      reservedAmount: "0",
      settledAmount: "0",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedModels: ["test-chat"],
      status: "active"
    });
    repository.createRequest({
      id: "req_session",
      model: "test-chat",
      status: "running",
      inputTokensEstimate: 1,
      maxOutputTokens: 2,
      maxCharge: "400"
    });

    const reserved = repository.reservePaymentSession({
      sessionId: "sess_repo",
      reservationId: "rsv_repo",
      requestId: "req_session",
      customerId: "cust_repo",
      requestHash: "hash_request",
      model: "test-chat",
      amount: "400"
    });
    expect(reserved.kind).toBe("reserved");
    expect(repository.getPaymentSession("sess_repo")?.remainingAuthorizedAmount).toBe("600");
    expect(repository.getPaymentSession("sess_repo")?.reservedAmount).toBe("400");

    const mutated = repository.reservePaymentSession({
      sessionId: "sess_repo",
      reservationId: "rsv_other",
      requestId: "req_session",
      customerId: "cust_repo",
      requestHash: "different_hash",
      model: "test-chat",
      amount: "400"
    });
    expect(mutated.kind).toBe("mutated_request");

    const settled = repository.settlePaymentReservation("rsv_repo", "125");
    expect(settled.actualAmount).toBe("125");
    expect(settled.releasedAmount).toBe("275");
    expect(repository.getPaymentSession("sess_repo")?.remainingAuthorizedAmount).toBe("875");
    expect(repository.getPaymentSession("sess_repo")?.reservedAmount).toBe("0");
    expect(repository.getPaymentSession("sess_repo")?.settledAmount).toBe("125");

    repository.createRequest({
      id: "req_release",
      model: "test-chat",
      status: "running",
      inputTokensEstimate: 1,
      maxOutputTokens: 2,
      maxCharge: "900"
    });
    const tooLarge = repository.reservePaymentSession({
      sessionId: "sess_repo",
      reservationId: "rsv_too_large",
      requestId: "req_release",
      customerId: "cust_repo",
      requestHash: "hash_release",
      model: "test-chat",
      amount: "900"
    });
    expect(tooLarge.kind).toBe("insufficient_funds");

    const released = repository.reservePaymentSession({
      sessionId: "sess_repo",
      reservationId: "rsv_release",
      requestId: "req_release",
      customerId: "cust_repo",
      requestHash: "hash_release",
      model: "test-chat",
      amount: "200"
    });
    expect(released.kind).toBe("reserved");
    repository.releasePaymentReservation("rsv_release");
    expect(repository.getPaymentReservation("rsv_release")?.status).toBe("released");
    expect(repository.getPaymentSession("sess_repo")?.remainingAuthorizedAmount).toBe("875");

    expect(repository.revokePaymentSession("sess_repo", "cust_repo")).toBe(true);
    database.close();
  });
});
