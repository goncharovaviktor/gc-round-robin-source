import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseNextManager,
  classifyGetCourseResponse,
  normalizeEmail,
  normalizeManagerCode,
  normalizePool,
  normalizeUserId,
  retryDelaySeconds,
  sha256Hex,
  utf8ToBase64,
  validateManagerConfiguration,
  validateManagerCodes,
} from "../src/core.js";

test("round robin starts with the first manager and cycles exactly", () => {
  const codes = ["m1", "m2", "m3"];
  assert.equal(chooseNextManager(codes, ""), "m1");
  assert.equal(chooseNextManager(codes, "m1"), "m2");
  assert.equal(chooseNextManager(codes, "m2"), "m3");
  assert.equal(chooseNextManager(codes, "m3"), "m1");
});

test("unknown managers restart safely and inactive configured managers are skipped in order", () => {
  assert.equal(chooseNextManager(["m2", "m3"], "m1"), "m2");
  assert.equal(chooseNextManager(["m1", "m3"], "m2", ["m1", "m2", "m3"]), "m3");
  assert.equal(chooseNextManager(["m1", "m3"], "m3", ["m1", "m2", "m3"]), "m1");
});

test("10,003 allocations across five managers differ by at most one", () => {
  const codes = ["m1", "m2", "m3", "m4", "m5"];
  const counts = Object.fromEntries(codes.map((code) => [code, 0]));
  let last = "";
  for (let index = 0; index < 10_003; index += 1) {
    last = chooseNextManager(codes, last);
    counts[last] += 1;
  }
  const values = Object.values(counts);
  assert.ok(Math.max(...values) - Math.min(...values) <= 1);
  assert.equal(values.reduce((sum, value) => sum + value, 0), 10_003);
});

test("250,003 allocations remain exactly balanced without drift", () => {
  const codes = ["m1", "m2", "m3", "m4", "m5"];
  const counts = Object.fromEntries(codes.map((code) => [code, 0]));
  let last = "";
  for (let index = 0; index < 250_003; index += 1) {
    last = chooseNextManager(codes, last);
    counts[last] += 1;
  }
  const values = Object.values(counts);
  assert.equal(Math.max(...values) - Math.min(...values), 1);
  assert.equal(values.reduce((sum, value) => sum + value, 0), 250_003);
});

test("independent pools keep independent positions", () => {
  const poolA = ["a1", "a2", "a3"];
  const poolB = ["b1", "b2"];
  let lastA = "";
  let lastB = "";
  lastA = chooseNextManager(poolA, lastA);
  lastA = chooseNextManager(poolA, lastA);
  lastB = chooseNextManager(poolB, lastB);
  assert.equal(lastA, "a2");
  assert.equal(lastB, "b1");
  assert.equal(chooseNextManager(poolA, lastA), "a3");
  assert.equal(chooseNextManager(poolB, lastB), "b2");
});

test("identifiers reject unsafe or oversized values", () => {
  assert.equal(normalizePool("segment_1"), "segment_1");
  assert.equal(normalizePool("segment 1"), "");
  assert.equal(normalizeManagerCode("s1_manager_2"), "s1_manager_2");
  assert.equal(normalizeManagerCode("x; DROP TABLE"), "");
  assert.equal(normalizeUserId("516595363"), "516595363");
  assert.equal(normalizeUserId("516x"), "");
  assert.equal(normalizeEmail(" TEST@Example.com "), "test@example.com");
  assert.equal(normalizeEmail("not-an-email"), "");
  assert.deepEqual(validateManagerCodes(["m1", "m1"]), []);
});

test("GetCourse success response is accepted", () => {
  const result = classifyGetCourseResponse(
    200,
    JSON.stringify({ success: true, result: { success: true, error: false } }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.retryable, false);
});

test("temporary HTTP responses and invalid JSON are retried", () => {
  assert.equal(classifyGetCourseResponse(408, "timeout").retryable, true);
  assert.equal(classifyGetCourseResponse(425, "early").retryable, true);
  assert.equal(classifyGetCourseResponse(429, "busy").retryable, true);
  assert.equal(classifyGetCourseResponse(503, "down").retryable, true);
  assert.equal(classifyGetCourseResponse(200, "not-json").retryable, true);
});

test("client errors are permanent and do not create a retry storm", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const result = classifyGetCourseResponse(status, "rejected");
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
  }
});

test("permanent GetCourse rejection is not retried forever", () => {
  const result = classifyGetCourseResponse(
    200,
    JSON.stringify({
      success: true,
      result: { success: false, error: true, error_message: "Unknown additional field" },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.errorCode, "GC_PERMANENT_REJECTION");
});

test("retry delay uses capped exponential backoff", () => {
  assert.equal(retryDelaySeconds(1), 30);
  assert.equal(retryDelaySeconds(2), 60);
  assert.equal(retryDelaySeconds(8), 3_600);
  assert.equal(retryDelaySeconds(100), 3_600);
});

test("UTF-8 JSON payload is base64 encoded without corruption", () => {
  const source = JSON.stringify({ manager: "Алексей", code: "s1_manager_1" });
  const decoded = Buffer.from(utf8ToBase64(source), "base64").toString("utf8");
  assert.equal(decoded, source);
});

test("manager configuration is normalized and ordered", () => {
  const result = validateManagerConfiguration({
    version: 7,
    pools: [
      {
        pool: "segment_1",
        initialLastManagerCode: "m2",
        managers: [
          { code: "m1", name: "Менеджер 1", active: true },
          { code: "m2", name: "Менеджер 2", active: false },
          { code: "m3", name: "Менеджер 3", active: true },
        ],
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, 7);
  assert.equal(result.poolCount, 1);
  assert.equal(result.managerCount, 3);
  assert.deepEqual(
    result.normalized.pools[0].managers.map(({ code, active, sortOrder }) => ({ code, active, sortOrder })),
    [
      { code: "m1", active: true, sortOrder: 1 },
      { code: "m2", active: false, sortOrder: 2 },
      { code: "m3", active: true, sortOrder: 3 },
    ],
  );
});

test("manager configuration rejects dangerous ambiguous states", () => {
  const basePool = {
    pool: "segment_1",
    managers: [{ code: "m1", name: "M1", active: true }],
  };
  assert.equal(validateManagerConfiguration({ version: 0, pools: [basePool] }).ok, false);
  assert.equal(
    validateManagerConfiguration({ version: 1, pools: [basePool, basePool] }).error,
    "CONFIG_POOL_DUPLICATE",
  );
  assert.equal(
    validateManagerConfiguration({
      version: 1,
      pools: [{ pool: "segment_1", managers: [{ code: "m1", active: false }] }],
    }).error,
    "CONFIG_NO_ACTIVE_MANAGERS",
  );
  assert.equal(
    validateManagerConfiguration({
      version: 1,
      pools: [{
        pool: "segment_1",
        managers: [
          { code: "m1", active: true },
          { code: "m1", active: true },
        ],
      }],
    }).error,
    "CONFIG_MANAGER_CODE_DUPLICATE",
  );
  assert.equal(
    validateManagerConfiguration({
      version: 1,
      pools: [{ ...basePool, initialLastManagerCode: "unknown" }],
    }).error,
    "CONFIG_INITIAL_MANAGER_UNKNOWN",
  );
});

test("configuration hash is deterministic and changes with content", async () => {
  const first = await sha256Hex('{"version":1}');
  const second = await sha256Hex('{"version":1}');
  const changed = await sha256Hex('{"version":2}');
  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(first, /^[0-9a-f]{64}$/);
});
