import { DurableObject } from "cloudflare:workers";
import { MANAGER_CONFIG } from "./manager-config.js";
import {
  LIMITS,
  VERSION,
  chooseNextManager,
  classifyGetCourseResponse,
  constantTimeEquals,
  jsonResponse,
  maskEmail,
  normalizeEmail,
  normalizeHttpsBaseUrl,
  normalizeManagerCode,
  normalizePool,
  normalizeText,
  normalizeUserId,
  retryDelaySeconds,
  safeErrorMessage,
  sha256Hex,
  textResponse,
  utf8ToBase64,
  validateManagerConfiguration,
  validateManagerCodes,
} from "./core.js";

const OUTBOX_BATCH_SIZE = 50;
const OUTBOX_RETRY_MS = 30_000;
const OUTBOX_MAX_RETRY_MS = 15 * 60_000;
const MANAGER_CONFIGURATION_CACHE_MS = 60_000;
const HEALTH_CACHE_MS = 30_000;
const SOURCE_MANAGER_CONFIGURATION = validateManagerConfiguration(MANAGER_CONFIG);
let sourceManagerConfigurationHashPromise;
let managerConfigurationCache;
let healthResponseCache;

export class PoolAllocator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.flushPromise = null;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS allocator_state (
        state_key TEXT PRIMARY KEY,
        state_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        job_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at)");
  }

  async allocateAndEnqueue(input) {
    const pool = normalizePool(input?.pool);
    const userId = normalizeUserId(input?.userId);
    const userEmail = normalizeEmail(input?.userEmail);
    const jobId = normalizeText(input?.jobId);
    const createdAt = normalizeText(input?.createdAt);
    const activeManagerCodes = validateManagerCodes(input?.activeManagerCodes);
    const allManagerCodes = validateManagerCodes(input?.allManagerCodes);
    const initialLastManagerCode = normalizeManagerCode(input?.initialLastManagerCode);

    if (
      !pool ||
      !userId ||
      !userEmail ||
      !jobId ||
      !createdAt ||
      !activeManagerCodes.length ||
      !allManagerCodes.length
    ) {
      throw new Error("Invalid allocation input.");
    }

    const result = this.ctx.storage.transactionSync(() => {
      const stateRow = this.sql
        .exec(
          "SELECT state_value FROM allocator_state WHERE state_key = 'last_manager_code' LIMIT 1",
        )
        .toArray()[0];
      const sequenceRow = this.sql
        .exec(
          "SELECT state_value FROM allocator_state WHERE state_key = 'sequence_number' LIMIT 1",
        )
        .toArray()[0];
      const lastManagerCode = normalizeManagerCode(stateRow?.state_value) || initialLastManagerCode;
      const sequenceNumber = (Number(sequenceRow?.state_value) || 0) + 1;
      const managerCode = chooseNextManager(activeManagerCodes, lastManagerCode, allManagerCodes);
      if (!managerCode) throw new Error("No active manager code is available.");

      const job = {
        schemaVersion: 1,
        jobId,
        mode: "allocate",
        pool,
        userId,
        userEmail,
        managerCode,
        sequenceNumber,
        createdAt,
      };

      this.sql.exec(
        `INSERT INTO outbox (job_id, payload, created_at) VALUES (?, ?, ?)`,
        jobId,
        JSON.stringify(job),
        createdAt,
      );
      this.sql.exec(
        `INSERT INTO allocator_state (state_key, state_value, updated_at)
         VALUES ('last_manager_code', ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
           state_value = excluded.state_value,
           updated_at = excluded.updated_at`,
        managerCode,
        createdAt,
      );
      this.sql.exec(
        `INSERT INTO allocator_state (state_key, state_value, updated_at)
         VALUES ('sequence_number', ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
           state_value = excluded.state_value,
           updated_at = excluded.updated_at`,
        String(sequenceNumber),
        createdAt,
      );

      return { jobId, pool, managerCode, sequenceNumber };
    });

    await this.scheduleOutboxFlush();
    return result;
  }

  async enqueueRepair(input) {
    const pool = normalizePool(input?.pool);
    const userId = normalizeUserId(input?.userId);
    const userEmail = normalizeEmail(input?.userEmail);
    const managerCode = normalizeManagerCode(input?.managerCode);
    const jobId = normalizeText(input?.jobId);
    const createdAt = normalizeText(input?.createdAt);

    if (!pool || !userId || !userEmail || !managerCode || !jobId || !createdAt) {
      throw new Error("Invalid repair input.");
    }

    const job = {
      schemaVersion: 1,
      jobId,
      mode: "repair",
      pool,
      userId,
      userEmail,
      managerCode,
      sequenceNumber: 0,
      createdAt,
    };

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO outbox (job_id, payload, created_at) VALUES (?, ?, ?)`,
        jobId,
        JSON.stringify(job),
        createdAt,
      );
    });

    await this.scheduleOutboxFlush();
    return { jobId, pool, managerCode };
  }

  async findLatestOutboxAssignment(userIdValue) {
    const userId = normalizeUserId(userIdValue);
    if (!userId) return "";
    const row = this.sql
      .exec(
        `SELECT json_extract(payload, '$.managerCode') AS manager_code
           FROM outbox
          WHERE json_extract(payload, '$.userId') = ?
          ORDER BY created_at DESC
          LIMIT 1`,
        userId,
      )
      .toArray()[0];
    return normalizeManagerCode(row?.manager_code);
  }

  async scheduleOutboxFlush() {
    try {
      await this.ctx.storage.setAlarm(Date.now() + 100);
    } catch {
      // The five-minute cron is a second recovery path for a committed outbox row.
    }
  }

  async flushOutbox() {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushOutboxInternal().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  async flushOutboxInternal() {
    const rows = this.sql
      .exec(
        "SELECT job_id, payload FROM outbox ORDER BY created_at, job_id LIMIT ?",
        OUTBOX_BATCH_SIZE,
      )
      .toArray();

    if (!rows.length) return { sent: 0, remaining: 0 };

    try {
      await this.env.GC_WRITE_QUEUE.sendBatch(
        rows.map((row) => ({ body: JSON.parse(row.payload) })),
      );

      this.ctx.storage.transactionSync(() => {
        for (const row of rows) {
          this.sql.exec("DELETE FROM outbox WHERE job_id = ?", row.job_id);
        }
        this.sql.exec(
          `INSERT INTO allocator_state (state_key, state_value, updated_at)
           VALUES ('outbox_failure_count', '0', ?)
           ON CONFLICT(state_key) DO UPDATE SET
             state_value = '0', updated_at = excluded.updated_at`,
          new Date().toISOString(),
        );
      });
    } catch (error) {
      const failureCount = this.ctx.storage.transactionSync(() => {
        const row = this.sql
          .exec(
            "SELECT state_value FROM allocator_state WHERE state_key = 'outbox_failure_count' LIMIT 1",
          )
          .toArray()[0];
        const next = (Number(row?.state_value) || 0) + 1;
        this.sql.exec(
          `INSERT INTO allocator_state (state_key, state_value, updated_at)
           VALUES ('outbox_failure_count', ?, ?)
           ON CONFLICT(state_key) DO UPDATE SET
             state_value = excluded.state_value, updated_at = excluded.updated_at`,
          String(next),
          new Date().toISOString(),
        );
        return next;
      });
      const retryMs = Math.min(
        OUTBOX_MAX_RETRY_MS,
        OUTBOX_RETRY_MS * 2 ** Math.min(failureCount - 1, 5),
      );
      try {
        await this.ctx.storage.setAlarm(Date.now() + retryMs);
      } catch {
        // The cron recovery path remains available.
      }
      throw error;
    }

    const countRow = this.sql.exec("SELECT COUNT(*) AS total FROM outbox").toArray()[0];
    const remaining = Number(countRow?.total) || 0;
    if (remaining > 0) await this.scheduleOutboxFlush();
    return { sent: rows.length, remaining };
  }

  async alarm() {
    try {
      await this.flushOutbox();
    } catch {
      // A retry alarm was scheduled by flushOutboxInternal().
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      if (error instanceof RequestError) {
        return jsonResponse({ ok: false, error: error.code }, error.status);
      }
      console.error(`[gc-rr] unhandled: ${safeErrorMessage(error)}`);
      return textResponse("ERROR_INTERNAL", 500);
    }
  },

  async queue(batch, env) {
    if (batch.queue === "gc-manager-rr-dlq") {
      for (const message of batch.messages) {
        await persistDeadLetterMessage(message, env);
      }
      return;
    }
    for (const message of batch.messages) {
      await processQueueMessage(message, env);
    }
  },

  async scheduled(controller, env) {
    try {
      await ensureManagerConfiguration(env);
    } catch (error) {
      console.error(`[gc-rr] manager configuration unavailable: ${safeErrorMessage(error)}`);
      return;
    }
    await recoverDurableOutboxes(env);
    const scheduledAt = new Date(controller.scheduledTime || Date.now());
    if (scheduledAt.getUTCHours() === 3 && scheduledAt.getUTCMinutes() === 0) {
      await removeExpiredAppliedJobs(env);
    }
  },
};

async function routeRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return handleHealthRequest(env);
  }

  if (request.method === "POST" && (url.pathname === "/v1/allocate" || url.pathname === "/v1/repair")) {
    return handleAllocationRequest(request, env, url.pathname === "/v1/repair");
  }

  if (url.pathname.startsWith("/v1/admin/")) {
    return handleAdminRequest(request, env, url);
  }

  return textResponse("NOT_FOUND", 404);
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > LIMITS.MAX_BODY_BYTES) throw new RequestError("ERROR_BODY_TOO_LARGE", 413);

  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("ERROR_INVALID_JSON", 400);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITS.MAX_BODY_BYTES) {
      await reader.cancel("Body too large");
      throw new RequestError("ERROR_BODY_TOO_LARGE", 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(raw);
  } catch {
    throw new RequestError("ERROR_INVALID_JSON", 400);
  }
}

async function handleAllocationRequest(request, env, forceRepair) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestError) return textResponse(error.code, error.status);
    throw error;
  }

  if (!(await constantTimeEquals(body?.secret, env.WEBHOOK_SECRET))) {
    return textResponse("ERROR_UNAUTHORIZED", 401);
  }

  const pool = normalizePool(body?.pool);
  const userId = normalizeUserId(body?.user_id);
  const userEmail = normalizeEmail(body?.user_email);
  const isRepair = forceRepair || normalizeText(body?.mode).toLowerCase() === "repair";

  if (!pool) return textResponse("ERROR_INVALID_POOL", 400);
  if (!userId) return textResponse("ERROR_INVALID_USER_ID", 400);
  if (!userEmail) return textResponse("ERROR_INVALID_EMAIL", 400);
  if (!isGetCourseConfigValid(env)) return textResponse("ERROR_NOT_CONFIGURED", 503);

  try {
    await ensureManagerConfiguration(env);
  } catch (error) {
    const code = error instanceof ManagerConfigurationError ? error.code : "ERROR_MANAGER_CONFIG";
    console.error(`[gc-rr] allocation blocked: ${safeErrorMessage(error)}`);
    return textResponse(code, 503);
  }

  const createdAt = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const stub = env.POOL_ALLOCATOR.getByName(pool);

  if (isRepair) {
    const managerCode = await findRepairManagerCode(
      env,
      stub,
      pool,
      userId,
      body?.manager_code,
    );
    if (!managerCode) return textResponse("ERROR_NO_ASSIGNMENT", 404);

    const result = await stub.enqueueRepair({
      jobId,
      pool,
      userId,
      userEmail,
      managerCode,
      createdAt,
    });
    return textResponse("ACCEPTED_REPAIR", 200, { "X-RR-Job-Id": result.jobId });
  }

  const poolConfig = await getPoolConfiguration(env, pool);
  const activeManagerCodes = poolConfig.activeManagerCodes;
  if (!activeManagerCodes.length) return textResponse("ERROR_NO_ACTIVE_MANAGERS", 409);

  const result = await stub.allocateAndEnqueue({
    jobId,
    pool,
    userId,
    userEmail,
    activeManagerCodes,
    allManagerCodes: poolConfig.allManagerCodes,
    initialLastManagerCode: poolConfig.initialLastManagerCode,
    createdAt,
  });

  return textResponse("ACCEPTED", 200, { "X-RR-Job-Id": result.jobId });
}

async function getPoolConfiguration(env, pool) {
  const [managerResult, settings] = await env.RR_DB.batch([
    env.RR_DB.prepare(
      `SELECT manager_code, active
         FROM managers
        WHERE pool = ?1
        ORDER BY sort_order ASC, manager_code ASC`,
    ).bind(pool),
    env.RR_DB.prepare(
      `SELECT initial_last_manager_code
         FROM pool_settings
        WHERE pool = ?1
        LIMIT 1`,
    ).bind(pool),
  ]);
  return {
    activeManagerCodes: validateManagerCodes(
      (managerResult.results || [])
        .filter((row) => Number(row.active) === 1)
        .map((row) => row.manager_code),
    ),
    allManagerCodes: validateManagerCodes(
      (managerResult.results || []).map((row) => row.manager_code),
    ),
    initialLastManagerCode: normalizeManagerCode(
      settings.results?.[0]?.initial_last_manager_code,
    ),
  };
}

async function handleHealthRequest(env) {
  const cacheAllowed = !isInternalCacheDisabled(env);
  if (cacheAllowed && healthResponseCache?.expiresAt > Date.now()) {
    return jsonResponse(healthResponseCache.body, healthResponseCache.status);
  }

  try {
    const configuration = await ensureManagerConfiguration(env);
    const result = await env.RR_DB.prepare(
      `SELECT pool,
              SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_managers,
              COUNT(*) AS total_managers
         FROM managers
        GROUP BY pool
        ORDER BY pool`,
    ).all();
    const getCourseReady = isGetCourseConfigValid(env);
    const adminReady = normalizeText(env.ADMIN_TOKEN).length >= 32;
    const body = {
      ok: getCourseReady && adminReady,
      service: "gc-manager-round-robin",
      version: VERSION,
      database_ready: true,
      manager_configuration_ready: true,
      manager_configuration_version: configuration.version,
      getcourse_configuration_ready: getCourseReady,
      admin_token_ready: adminReady,
      pools: result.results || [],
      ...(!getCourseReady || !adminReady ? { error: "ERROR_NOT_CONFIGURED" } : {}),
    };
    const status = getCourseReady && adminReady ? 200 : 503;
    if (cacheAllowed) {
      healthResponseCache = { body, status, expiresAt: Date.now() + HEALTH_CACHE_MS };
    }
    return jsonResponse(body, status);
  } catch (error) {
    const code = error instanceof ManagerConfigurationError ? error.code : "ERROR_DATABASE_NOT_READY";
    const body = {
      ok: false,
      service: "gc-manager-round-robin",
      version: VERSION,
      database_ready: code !== "ERROR_DATABASE_NOT_READY",
      manager_configuration_ready: false,
      error: code,
    };
    if (cacheAllowed) {
      healthResponseCache = { body, status: 503, expiresAt: Date.now() + 10_000 };
    }
    return jsonResponse(body, 503);
  }
}

export async function ensureManagerConfiguration(env) {
  if (normalizeText(env.MANAGER_CONFIG_READY).toLowerCase() !== "true") {
    throw new ManagerConfigurationError("ERROR_MANAGER_CONFIG_NOT_READY");
  }
  if (!SOURCE_MANAGER_CONFIGURATION.ok) {
    throw new ManagerConfigurationError(SOURCE_MANAGER_CONFIGURATION.error);
  }
  const cacheAllowed = !isInternalCacheDisabled(env);
  if (cacheAllowed && managerConfigurationCache?.expiresAt > Date.now()) {
    return managerConfigurationCache.result;
  }

  if (!sourceManagerConfigurationHashPromise) {
    sourceManagerConfigurationHashPromise = sha256Hex(SOURCE_MANAGER_CONFIGURATION.serialized);
  }
  const sourceHash = await sourceManagerConfigurationHashPromise;

  let current;
  try {
    current = await env.RR_DB.prepare(
      `SELECT config_version, config_hash
         FROM configuration_state
        WHERE config_key = 'manager_config'
        LIMIT 1`,
    ).first();
  } catch (error) {
    console.error(`[gc-rr] D1 schema check failed: ${safeErrorMessage(error)}`);
    throw new ManagerConfigurationError("ERROR_DATABASE_NOT_READY");
  }

  const currentVersion = Number(current?.config_version) || 0;
  const currentHash = normalizeText(current?.config_hash);
  const sourceVersion = SOURCE_MANAGER_CONFIGURATION.version;

  if (currentVersion > sourceVersion) {
    throw new ManagerConfigurationError("ERROR_MANAGER_CONFIG_VERSION_ROLLBACK");
  }
  if (currentVersion === sourceVersion && currentVersion > 0) {
    if (currentHash !== sourceHash) {
      throw new ManagerConfigurationError("ERROR_MANAGER_CONFIG_VERSION_REUSED");
    }
    const result = {
      ready: true,
      synchronized: false,
      version: sourceVersion,
      poolCount: SOURCE_MANAGER_CONFIGURATION.poolCount,
      managerCount: SOURCE_MANAGER_CONFIGURATION.managerCount,
    };
    if (cacheAllowed) {
      managerConfigurationCache = {
        result,
        expiresAt: Date.now() + MANAGER_CONFIGURATION_CACHE_MS,
      };
    }
    return result;
  }

  const statements = [
    env.RR_DB.prepare("DELETE FROM managers"),
    env.RR_DB.prepare("DELETE FROM pool_settings"),
  ];

  for (const poolConfig of SOURCE_MANAGER_CONFIGURATION.normalized.pools) {
    statements.push(
      env.RR_DB.prepare(
        `INSERT INTO pool_settings (pool, initial_last_manager_code, notes, updated_at)
         VALUES (?1, ?2, 'Managed from src/manager-config.js', CURRENT_TIMESTAMP)`,
      ).bind(poolConfig.pool, poolConfig.initialLastManagerCode),
    );
    for (const manager of poolConfig.managers) {
      statements.push(
        env.RR_DB.prepare(
          `INSERT INTO managers (
             pool, manager_code, manager_name, active, sort_order, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ).bind(
          poolConfig.pool,
          manager.code,
          manager.name,
          manager.active ? 1 : 0,
          manager.sortOrder,
        ),
      );
    }
  }

  statements.push(
    env.RR_DB.prepare(
      `INSERT INTO configuration_state (
         config_key, config_version, config_hash, updated_at
       ) VALUES ('manager_config', ?1, ?2, CURRENT_TIMESTAMP)
       ON CONFLICT(config_key) DO UPDATE SET
         config_version = excluded.config_version,
         config_hash = excluded.config_hash,
         updated_at = excluded.updated_at`,
    ).bind(sourceVersion, sourceHash),
  );

  await env.RR_DB.batch(statements);

  const verification = await env.RR_DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_total,
            COUNT(DISTINCT pool) AS pool_total
       FROM managers`,
  ).first();
  if (
    Number(verification?.total) !== SOURCE_MANAGER_CONFIGURATION.managerCount ||
    Number(verification?.pool_total) !== SOURCE_MANAGER_CONFIGURATION.poolCount ||
    Number(verification?.active_total) < SOURCE_MANAGER_CONFIGURATION.poolCount
  ) {
    throw new ManagerConfigurationError("ERROR_MANAGER_CONFIG_SYNC_VERIFICATION");
  }

  const result = {
    ready: true,
    synchronized: true,
    version: sourceVersion,
    poolCount: SOURCE_MANAGER_CONFIGURATION.poolCount,
    managerCount: SOURCE_MANAGER_CONFIGURATION.managerCount,
  };
  if (cacheAllowed) {
    managerConfigurationCache = {
      result,
      expiresAt: Date.now() + MANAGER_CONFIGURATION_CACHE_MS,
    };
  }
  return result;
}

async function findRepairManagerCode(env, stub, pool, userId, requestedManagerCode) {
  const explicitCode = normalizeManagerCode(requestedManagerCode);
  if (explicitCode) {
    const configured = await env.RR_DB.prepare(
      "SELECT manager_code FROM managers WHERE pool = ?1 AND manager_code = ?2 LIMIT 1",
    )
      .bind(pool, explicitCode)
      .first();
    return configured ? explicitCode : "";
  }

  const latestJob = await env.RR_DB.prepare(
    `SELECT manager_code
       FROM jobs
      WHERE pool = ?1 AND user_id = ?2
      ORDER BY created_at DESC
      LIMIT 1`,
  )
    .bind(pool, userId)
    .first();
  if (normalizeManagerCode(latestJob?.manager_code)) return normalizeManagerCode(latestJob.manager_code);

  const legacy = await env.RR_DB.prepare(
    `SELECT manager_code
       FROM legacy_assignments
      WHERE pool = ?1 AND user_id = ?2
      ORDER BY created_at DESC
      LIMIT 1`,
  )
    .bind(pool, userId)
    .first();
  if (normalizeManagerCode(legacy?.manager_code)) return normalizeManagerCode(legacy.manager_code);

  return normalizeManagerCode(await stub.findLatestOutboxAssignment(userId));
}

async function processQueueMessage(message, env) {
  const job = normalizeJob(message.body);
  if (!job) {
    await moveToDeadLetter(message, env, null, "INVALID_QUEUE_MESSAGE", "Invalid queue message.");
    return;
  }

  try {
    await ensureJobRow(env, job);
    const existing = await env.RR_DB.prepare(
      "SELECT status, attempts FROM jobs WHERE job_id = ?1 LIMIT 1",
    )
      .bind(job.jobId)
      .first();

    if (existing?.status === "APPLIED" || existing?.status === "DEAD") {
      message.ack();
      return;
    }

    const attempt = (Number(existing?.attempts) || 0) + 1;
    await env.RR_DB.prepare(
      `UPDATE jobs
          SET status = 'PROCESSING', attempts = ?2, updated_at = ?3,
              last_error_code = NULL, last_error_message = NULL
        WHERE job_id = ?1`,
    )
      .bind(job.jobId, attempt, new Date().toISOString())
      .run();

    const outcome = await writeManagerCodeToGetCourse(env, job);
    if (outcome.ok) {
      const appliedAt = new Date().toISOString();
      await env.RR_DB.prepare(
        `UPDATE jobs
            SET status = 'APPLIED', updated_at = ?2, applied_at = ?2,
                last_http_status = ?3, last_error_code = NULL, last_error_message = NULL
          WHERE job_id = ?1`,
      )
        .bind(job.jobId, appliedAt, outcome.httpStatus)
        .run();
      message.ack();
      return;
    }

    if (outcome.retryable && attempt < LIMITS.MAX_DELIVERY_ATTEMPTS) {
      await env.RR_DB.prepare(
        `UPDATE jobs
            SET status = 'RETRY_SCHEDULED', updated_at = ?2,
                last_http_status = ?3, last_error_code = ?4, last_error_message = ?5
          WHERE job_id = ?1`,
      )
        .bind(
          job.jobId,
          new Date().toISOString(),
          outcome.httpStatus,
          outcome.errorCode,
          outcome.message,
        )
        .run();
      message.retry({ delaySeconds: retryDelaySeconds(attempt) });
      return;
    }

    await moveToDeadLetter(message, env, job, outcome.errorCode, outcome.message, outcome.httpStatus);
  } catch (error) {
    console.error(`[gc-rr] queue job ${job.jobId}: ${safeErrorMessage(error)}`);
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts || 1) });
  }
}

function normalizeJob(value) {
  const job = value && typeof value === "object" ? value : {};
  const normalized = {
    schemaVersion: Number(job.schemaVersion) || 0,
    jobId: normalizeText(job.jobId),
    mode: normalizeText(job.mode) === "repair" ? "repair" : "allocate",
    pool: normalizePool(job.pool),
    userId: normalizeUserId(job.userId),
    userEmail: normalizeEmail(job.userEmail),
    managerCode: normalizeManagerCode(job.managerCode),
    sequenceNumber: Math.max(0, Number(job.sequenceNumber) || 0),
    createdAt: normalizeText(job.createdAt),
  };
  if (
    normalized.schemaVersion !== 1 ||
    !/^[0-9a-f-]{36}$/i.test(normalized.jobId) ||
    !normalized.pool ||
    !normalized.userId ||
    !normalized.userEmail ||
    !normalized.managerCode ||
    !normalized.createdAt ||
    (normalized.mode === "allocate" && normalized.sequenceNumber < 1)
  ) {
    return null;
  }
  return normalized;
}

async function ensureJobRow(env, job) {
  await env.RR_DB.prepare(
    `INSERT INTO jobs (
       job_id, mode, pool, user_id, user_email, manager_code, sequence_number,
       status, attempts, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'QUEUED', 0, ?8, ?8)
     ON CONFLICT(job_id) DO NOTHING`,
  )
    .bind(
      job.jobId,
      job.mode,
      job.pool,
      job.userId,
      job.userEmail,
      job.managerCode,
      job.sequenceNumber || null,
      job.createdAt,
    )
    .run();
}

async function writeManagerCodeToGetCourse(env, job) {
  const baseUrl = normalizeHttpsBaseUrl(env.GC_BASE_URL);
  const fieldName = normalizeText(env.GC_MANAGER_CODE_FIELD);
  const addfields = { [fieldName]: job.managerCode };
  const params = {
    user: { email: job.userEmail, addfields },
    system: { refresh_if_exists: 1 },
  };
  const payload = new URLSearchParams({
    action: "add",
    key: normalizeText(env.GC_API_KEY),
    params: utf8ToBase64(JSON.stringify(params)),
  });

  let response;
  try {
    response = await fetch(`${baseUrl}/pl/api/users`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: payload.toString(),
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      httpStatus: 0,
      errorCode: "GC_NETWORK_ERROR",
      message: `GetCourse request failed: ${safeErrorMessage(error)}`,
    };
  }

  const responseBody = await response.text();
  return {
    ...classifyGetCourseResponse(response.status, responseBody),
    httpStatus: response.status,
  };
}

async function moveToDeadLetter(message, env, job, errorCode, errorMessage, httpStatus = 0) {
  const deadMessage = {
    schemaVersion: 1,
    failedAt: new Date().toISOString(),
    jobId: job?.jobId || "unknown",
    mode: job?.mode || "unknown",
    pool: job?.pool || "unknown",
    userId: job?.userId || "unknown",
    userEmail: job?.userEmail || "",
    managerCode: job?.managerCode || "",
    sequenceNumber: job?.sequenceNumber || 0,
    errorCode: normalizeText(errorCode).slice(0, 100),
    errorMessage: normalizeText(errorMessage).slice(0, LIMITS.MAX_ERROR_LENGTH),
    httpStatus: Number(httpStatus) || 0,
  };

  try {
    await env.GC_WRITE_DLQ.send(deadMessage);
    if (job?.jobId) {
      await env.RR_DB.prepare(
        `UPDATE jobs
            SET status = 'DEAD', updated_at = ?2, dead_at = ?2,
                last_http_status = ?3, last_error_code = ?4, last_error_message = ?5
          WHERE job_id = ?1`,
      )
        .bind(
          job.jobId,
          deadMessage.failedAt,
          deadMessage.httpStatus,
          deadMessage.errorCode,
          deadMessage.errorMessage,
        )
        .run();
    }
    message.ack();
  } catch (error) {
    console.error(`[gc-rr] DLQ transfer failed for ${job?.jobId || "unknown"}: ${safeErrorMessage(error)}`);
    message.retry({ delaySeconds: 300 });
  }
}

async function persistDeadLetterMessage(message, env) {
  try {
    const raw = message.body && typeof message.body === "object" ? message.body : {};
    const originalJob = normalizeJob(raw);
    const jobId = normalizeText(raw.jobId) || originalJob?.jobId || "unknown";
    const pool = normalizePool(raw.pool) || originalJob?.pool || "unknown";
    const userId = normalizeUserId(raw.userId) || originalJob?.userId || "unknown";
    const managerCode = normalizeManagerCode(raw.managerCode) || originalJob?.managerCode || "unknown";
    const errorCode = normalizeText(raw.errorCode) || "QUEUE_RETRIES_EXHAUSTED";
    const receivedAt = new Date().toISOString();

    if (originalJob) {
      await ensureJobRow(env, originalJob);
      await env.RR_DB.prepare(
        `UPDATE jobs
            SET status = 'DEAD', updated_at = ?2, dead_at = ?2,
                last_error_code = ?3,
                last_error_message = COALESCE(last_error_message, 'Queue delivery retries exhausted')
          WHERE job_id = ?1 AND status <> 'APPLIED'`,
      )
        .bind(originalJob.jobId, receivedAt, errorCode)
        .run();
    }

    await env.RR_DB.prepare(
      `INSERT INTO dead_letters (
         dead_letter_id, job_id, pool, user_id, manager_code,
         error_code, payload_json, received_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(dead_letter_id) DO NOTHING`,
    )
      .bind(
        normalizeText(message.id) || crypto.randomUUID(),
        jobId,
        pool,
        userId,
        managerCode,
        errorCode.slice(0, 100),
        JSON.stringify(raw).slice(0, 20_000),
        receivedAt,
      )
      .run();
    message.ack();
  } catch (error) {
    console.error(`[gc-rr] DLQ persistence failed: ${safeErrorMessage(error)}`);
    message.retry({ delaySeconds: 300 });
  }
}

async function recoverDurableOutboxes(env) {
  const result = await env.RR_DB.prepare("SELECT DISTINCT pool FROM managers ORDER BY pool").all();
  const pools = (result.results || []).map((row) => normalizePool(row.pool)).filter(Boolean);
  for (let index = 0; index < pools.length; index += 10) {
    const chunk = pools.slice(index, index + 10);
    await Promise.allSettled(
      chunk.map((pool) => env.POOL_ALLOCATOR.getByName(pool).flushOutbox()),
    );
  }
}

async function removeExpiredAppliedJobs(env) {
  const retentionDays = Math.min(365, Math.max(30, Number(env.RETENTION_DAYS) || 90));
  await env.RR_DB.prepare(
    `DELETE FROM jobs
      WHERE job_id IN (
        SELECT job_id
          FROM jobs
         WHERE status = 'APPLIED'
           AND applied_at < datetime('now', ?1)
         ORDER BY applied_at
         LIMIT 500
      )`,
  )
    .bind(`-${retentionDays} days`)
    .run();
}

async function handleAdminRequest(request, env, url) {
  const bearer = normalizeText(request.headers.get("authorization")).replace(/^Bearer\s+/i, "");
  if (!(await constantTimeEquals(bearer, env.ADMIN_TOKEN))) {
    return jsonResponse({ ok: false, error: "UNAUTHORIZED" }, 401);
  }

  try {
    await ensureManagerConfiguration(env);
  } catch (error) {
    const code = error instanceof ManagerConfigurationError ? error.code : "ERROR_MANAGER_CONFIG";
    return jsonResponse({ ok: false, error: code }, 503);
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/config") {
    const result = await env.RR_DB.prepare(
      `SELECT pool,
              SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_managers,
              COUNT(*) AS total_managers
         FROM managers
        GROUP BY pool
        ORDER BY pool`,
    ).all();
    return jsonResponse({ ok: true, version: VERSION, pools: result.results || [] });
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/stats") {
    const result = await env.RR_DB.prepare(
      `SELECT pool, status, COUNT(*) AS total
         FROM jobs
        GROUP BY pool, status
        ORDER BY pool, status`,
    ).all();
    return jsonResponse({ ok: true, version: VERSION, jobs: result.results || [] });
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/user") {
    const pool = normalizePool(url.searchParams.get("pool"));
    const userId = normalizeUserId(url.searchParams.get("user_id"));
    if (!pool || !userId) return jsonResponse({ ok: false, error: "INVALID_QUERY" }, 400);
    const result = await env.RR_DB.prepare(
      `SELECT job_id, mode, pool, user_id, user_email, manager_code, sequence_number, status,
              attempts, last_http_status, last_error_code, last_error_message,
              created_at, updated_at, applied_at, dead_at
         FROM jobs
        WHERE pool = ?1 AND user_id = ?2
        ORDER BY created_at DESC
        LIMIT 20`,
    )
      .bind(pool, userId)
      .all();
    const jobs = (result.results || []).map((row) => ({ ...row, user_email: maskEmail(row.user_email) }));
    return jsonResponse({ ok: true, jobs });
  }

  if (request.method === "POST" && url.pathname === "/v1/admin/requeue") {
    const body = await readJsonBody(request);
    const originalJobId = normalizeText(body?.job_id);
    const original = await env.RR_DB.prepare(
      `SELECT pool, user_id, user_email, manager_code
         FROM jobs
        WHERE job_id = ?1
        LIMIT 1`,
    )
      .bind(originalJobId)
      .first();
    if (!original) return jsonResponse({ ok: false, error: "JOB_NOT_FOUND" }, 404);

    const jobId = crypto.randomUUID();
    await env.POOL_ALLOCATOR.getByName(original.pool).enqueueRepair({
      jobId,
      pool: original.pool,
      userId: original.user_id,
      userEmail: original.user_email,
      managerCode: original.manager_code,
      createdAt: new Date().toISOString(),
    });
    return jsonResponse({ ok: true, status: "ACCEPTED_REPAIR", job_id: jobId });
  }

  return jsonResponse({ ok: false, error: "NOT_FOUND" }, 404);
}

function isGetCourseConfigValid(env) {
  const baseUrl = normalizeHttpsBaseUrl(env.GC_BASE_URL);
  return Boolean(
    baseUrl &&
      !/YOUR-SCHOOL/i.test(baseUrl) &&
      normalizeText(env.GC_API_KEY) &&
      normalizeText(env.GC_MANAGER_CODE_FIELD) &&
      normalizeText(env.WEBHOOK_SECRET).length >= 32,
  );
}

function isInternalCacheDisabled(env) {
  return normalizeText(env.DISABLE_INTERNAL_CACHE).toLowerCase() === "true";
}

class RequestError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

class ManagerConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
