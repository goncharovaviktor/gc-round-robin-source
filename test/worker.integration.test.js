import { env, exports as workerExports } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  evictDurableObject,
  getQueueResult,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";

const WEBHOOK_SECRET = "integration-test-webhook-secret-0123456789";

function allocationRequest(index, pool = "segment_1", secret = WEBHOOK_SECRET) {
  return new Request("https://worker.test/v1/allocate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret,
      pool,
      user_id: String(900_000_000 + index),
      user_email: `load-${index}@example.test`,
    }),
  });
}

function queueJob(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: crypto.randomUUID(),
    mode: "allocate",
    pool: `queue_${crypto.randomUUID().slice(0, 8)}`,
    userId: "516595363",
    userEmail: "student@example.test",
    managerCode: "s1_manager_1",
    sequenceNumber: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function callQueue(job, id = crypto.randomUUID()) {
  const batch = createMessageBatch("gc-manager-rr-write", [
    { id, timestamp: new Date(), attempts: 1, body: job },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

async function callDeadLetterQueue(body, id = crypto.randomUUID()) {
  const batch = createMessageBatch("gc-manager-rr-dlq", [
    { id, timestamp: new Date(), attempts: 1, body },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

describe("deployment readiness", () => {
  it("applies migrations and synchronizes the manager configuration", async () => {
    const response = await workerExports.default.fetch(new Request("https://worker.test/health"), env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      database_ready: true,
      manager_configuration_ready: true,
      manager_configuration_version: 1,
    });
    expect(body.pools).toHaveLength(4);

    const managerCount = await env.RR_DB.prepare("SELECT COUNT(*) AS total FROM managers").first();
    expect(Number(managerCount.total)).toBe(20);
  });

  it("rejects unauthorized and malformed allocation requests", async () => {
    const unauthorized = await workerExports.default.fetch(allocationRequest(1, "segment_1", "wrong"), env);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).toBe("ERROR_UNAUTHORIZED");

    const malformed = new Request("https://worker.test/v1/allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: WEBHOOK_SECRET,
        pool: "segment 1",
        user_id: "not-a-number",
        user_email: "invalid",
      }),
    });
    const invalid = await workerExports.default.fetch(malformed, env);
    expect(invalid.status).toBe(400);

    const oversized = new Request("https://worker.test/v1/allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(13_000) }),
    });
    const tooLarge = await worker.fetch(oversized, env);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.text()).toBe("ERROR_BODY_TOO_LARGE");
  });

  it("synchronizes configuration safely under 100 concurrent cold-start checks", async () => {
    await env.RR_DB.batch([
      env.RR_DB.prepare("DELETE FROM managers"),
      env.RR_DB.prepare("DELETE FROM pool_settings"),
      env.RR_DB.prepare("DELETE FROM configuration_state"),
    ]);

    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        workerExports.default.fetch(new Request("https://worker.test/health"), env),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);

    const counts = await env.RR_DB.prepare(
      "SELECT COUNT(*) AS managers, COUNT(DISTINCT pool) AS pools FROM managers",
    ).first();
    expect(Number(counts.managers)).toBe(20);
    expect(Number(counts.pools)).toBe(4);
  });

  it("blocks a changed manager file when its version was not increased", async () => {
    const ready = await workerExports.default.fetch(new Request("https://worker.test/health"), env);
    expect(ready.status).toBe(200);

    await env.RR_DB.prepare(
      "UPDATE configuration_state SET config_hash = 'tampered' WHERE config_key = 'manager_config'",
    ).run();
    const blocked = await worker.fetch(new Request("https://worker.test/health"), env);
    const body = await blocked.json();
    expect(blocked.status).toBe(503);
    expect(body.error).toBe("ERROR_MANAGER_CONFIG_VERSION_REUSED");

    await env.RR_DB.prepare(
      "DELETE FROM configuration_state WHERE config_key = 'manager_config'",
    ).run();
    const restored = await worker.fetch(new Request("https://worker.test/health"), env);
    expect(restored.status).toBe(200);
  });
});

describe("atomic allocation under load", () => {
  it("accepts 1,000 simultaneous requests with no missing or duplicate sequence", async () => {
    const health = await workerExports.default.fetch(new Request("https://worker.test/health"), env);
    expect(health.status).toBe(200);

    const responses = await Promise.all(
      Array.from({ length: 1_000 }, (_, index) =>
        workerExports.default.fetch(allocationRequest(index + 1), env),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.headers.get("X-RR-Job-Id"))).size).toBe(1_000);

    const stub = env.POOL_ALLOCATOR.getByName("segment_1");
    const state = await runInDurableObject(stub, async (instance) => {
      const outbox = instance.sql
        .exec("SELECT payload FROM outbox ORDER BY CAST(json_extract(payload, '$.sequenceNumber') AS INTEGER)")
        .toArray()
        .map((row) => JSON.parse(row.payload));
      const sequence = Number(
        instance.sql
          .exec("SELECT state_value FROM allocator_state WHERE state_key = 'sequence_number'")
          .toArray()[0]?.state_value,
      );
      return { outbox, sequence };
    });

    expect(state.sequence).toBe(1_000);
    expect(state.outbox).toHaveLength(1_000);
    expect(state.outbox.map((job) => job.sequenceNumber)).toEqual(
      Array.from({ length: 1_000 }, (_, index) => index + 1),
    );
    const counts = new Map();
    for (const job of state.outbox) counts.set(job.managerCode, (counts.get(job.managerCode) || 0) + 1);
    expect([...counts.values()].sort((a, b) => a - b)).toEqual([200, 200, 200, 200, 200]);
  });

  it("persists the cursor across Durable Object eviction", async () => {
    const stub = env.POOL_ALLOCATOR.getByName("eviction-pool");
    const base = {
      pool: "eviction-pool",
      userEmail: "student@example.test",
      activeManagerCodes: ["m1", "m2", "m3"],
      allManagerCodes: ["m1", "m2", "m3"],
      initialLastManagerCode: "",
    };
    for (let index = 1; index <= 7; index += 1) {
      await stub.allocateAndEnqueue({
        ...base,
        userId: String(index),
        jobId: crypto.randomUUID(),
        createdAt: new Date(Date.now() + index).toISOString(),
      });
    }
    await evictDurableObject(stub);
    const eighth = await stub.allocateAndEnqueue({
      ...base,
      userId: "8",
      jobId: crypto.randomUUID(),
      createdAt: new Date(Date.now() + 8).toISOString(),
    });
    expect(eighth.sequenceNumber).toBe(8);
    expect(eighth.managerCode).toBe("m2");

    const ninth = await stub.allocateAndEnqueue({
      ...base,
      activeManagerCodes: ["m1", "m3"],
      userId: "9",
      jobId: crypto.randomUUID(),
      createdAt: new Date(Date.now() + 9).toISOString(),
    });
    expect(ninth.sequenceNumber).toBe(9);
    expect(ninth.managerCode).toBe("m3");
  });

  it("repair writes do not advance the allocation cursor", async () => {
    const stub = env.POOL_ALLOCATOR.getByName("repair-pool");
    const base = {
      pool: "repair-pool",
      userEmail: "student@example.test",
      activeManagerCodes: ["m1", "m2", "m3"],
      allManagerCodes: ["m1", "m2", "m3"],
      initialLastManagerCode: "",
    };
    const first = await stub.allocateAndEnqueue({
      ...base,
      userId: "1",
      jobId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    await stub.enqueueRepair({
      pool: "repair-pool",
      userId: "1",
      userEmail: "student@example.test",
      managerCode: "m3",
      jobId: crypto.randomUUID(),
      createdAt: new Date(Date.now() + 1).toISOString(),
    });
    const second = await stub.allocateAndEnqueue({
      ...base,
      userId: "2",
      jobId: crypto.randomUUID(),
      createdAt: new Date(Date.now() + 2).toISOString(),
    });
    expect(first.managerCode).toBe("m1");
    expect(second.managerCode).toBe("m2");
    expect(second.sequenceNumber).toBe(2);
  });
});

describe("outbox and queue recovery", () => {
  it("keeps committed work when Queue send fails and deletes it only after success", async () => {
    const stub = env.POOL_ALLOCATOR.getByName("outbox-failure-pool");
    await stub.allocateAndEnqueue({
      pool: "outbox-failure-pool",
      userId: "100",
      userEmail: "student@example.test",
      jobId: crypto.randomUUID(),
      activeManagerCodes: ["m1", "m2"],
      allManagerCodes: ["m1", "m2"],
      initialLastManagerCode: "",
      createdAt: new Date().toISOString(),
    });

    const outcome = await runInDurableObject(stub, async (instance) => {
      const originalQueue = instance.env.GC_WRITE_QUEUE;
      instance.env.GC_WRITE_QUEUE = {
        async sendBatch() {
          throw new Error("simulated queue outage");
        },
      };
      let failed = false;
      try {
        await instance.flushOutbox();
      } catch {
        failed = true;
      }
      const retained = Number(instance.sql.exec("SELECT COUNT(*) AS total FROM outbox").toArray()[0].total);

      let sent = 0;
      instance.env.GC_WRITE_QUEUE = {
        async sendBatch(messages) {
          sent += messages.length;
        },
      };
      await instance.flushOutbox();
      const remaining = Number(instance.sql.exec("SELECT COUNT(*) AS total FROM outbox").toArray()[0].total);
      instance.env.GC_WRITE_QUEUE = originalQueue;
      return { failed, retained, sent, remaining };
    });

    expect(outcome).toEqual({ failed: true, retained: 1, sent: 1, remaining: 0 });
  });

  it("acknowledges a successful GetCourse write and ignores duplicate delivery", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, result: { success: true, error: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const job = queueJob();
    const first = await callQueue(job, "delivery-1");
    const second = await callQueue(job, "delivery-2");

    expect(first.explicitAcks).toContain("delivery-1");
    expect(second.explicitAcks).toContain("delivery-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = await env.RR_DB.prepare(
      "SELECT status, attempts, manager_code FROM jobs WHERE job_id = ?1",
    ).bind(job.jobId).first();
    expect(row).toMatchObject({ status: "APPLIED", attempts: 1, manager_code: "s1_manager_1" });
    fetchMock.mockRestore();
  });

  it("processes 250 queued GetCourse writes with no unacknowledged or missing job", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, result: { success: true, error: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const pool = `queue_load_${crypto.randomUUID().slice(0, 8)}`;
    const jobs = Array.from({ length: 250 }, (_, index) =>
      queueJob({
        pool,
        userId: String(700_000_000 + index),
        userEmail: `queue-load-${index}@example.test`,
        managerCode: `m${index % 5 + 1}`,
        sequenceNumber: index + 1,
      }),
    );

    let acknowledged = 0;
    for (let offset = 0; offset < jobs.length; offset += 10) {
      const messages = jobs.slice(offset, offset + 10).map((job, index) => ({
        id: `queue-load-${offset + index}`,
        timestamp: new Date(),
        attempts: 1,
        body: job,
      }));
      const batch = createMessageBatch("gc-manager-rr-write", messages);
      const ctx = createExecutionContext();
      await worker.queue(batch, env, ctx);
      const result = await getQueueResult(batch, ctx);
      acknowledged += result.explicitAcks.length;
      expect(result.retryMessages).toHaveLength(0);
    }

    expect(acknowledged).toBe(250);
    expect(fetchMock).toHaveBeenCalledTimes(250);
    const totals = await env.RR_DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'APPLIED' THEN 1 ELSE 0 END) AS applied,
              SUM(CASE WHEN attempts = 1 THEN 1 ELSE 0 END) AS first_attempt
         FROM jobs
        WHERE pool = ?1`,
    ).bind(pool).first();
    expect(Number(totals.total)).toBe(250);
    expect(Number(totals.applied)).toBe(250);
    expect(Number(totals.first_attempt)).toBe(250);
    fetchMock.mockRestore();
  });

  it("schedules a delayed retry for a temporary GetCourse failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("temporary outage", { status: 503 }),
    );
    const job = queueJob();
    const result = await callQueue(job, "retry-delivery");
    expect(result.retryMessages).toHaveLength(1);
    const row = await env.RR_DB.prepare(
      "SELECT status, attempts, last_http_status, last_error_code FROM jobs WHERE job_id = ?1",
    ).bind(job.jobId).first();
    expect(row).toMatchObject({
      status: "RETRY_SCHEDULED",
      attempts: 1,
      last_http_status: 503,
      last_error_code: "GC_HTTP_503",
    });
    fetchMock.mockRestore();
  });

  it("moves a permanent GetCourse rejection to the dead-letter path", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: { success: false, error: true, error_message: "Unknown additional field" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const job = queueJob();
    const result = await callQueue(job, "dead-delivery");
    expect(result.explicitAcks).toContain("dead-delivery");
    const row = await env.RR_DB.prepare(
      "SELECT status, attempts, last_error_code FROM jobs WHERE job_id = ?1",
    ).bind(job.jobId).first();
    expect(row).toMatchObject({
      status: "DEAD",
      attempts: 1,
      last_error_code: "GC_PERMANENT_REJECTION",
    });
    fetchMock.mockRestore();
  });

  it("persists an automatically exhausted Queue message in D1", async () => {
    const job = queueJob();
    const result = await callDeadLetterQueue(job, "automatic-dlq-delivery");
    expect(result.explicitAcks).toContain("automatic-dlq-delivery");

    const deadLetter = await env.RR_DB.prepare(
      "SELECT job_id, pool, manager_code, error_code FROM dead_letters WHERE dead_letter_id = ?1",
    ).bind("automatic-dlq-delivery").first();
    expect(deadLetter).toMatchObject({
      job_id: job.jobId,
      pool: job.pool,
      manager_code: job.managerCode,
      error_code: "QUEUE_RETRIES_EXHAUSTED",
    });

    const jobRow = await env.RR_DB.prepare(
      "SELECT status, last_error_code FROM jobs WHERE job_id = ?1",
    ).bind(job.jobId).first();
    expect(jobRow).toMatchObject({ status: "DEAD", last_error_code: "QUEUE_RETRIES_EXHAUSTED" });
  });
});
