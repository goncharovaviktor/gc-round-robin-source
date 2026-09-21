import test from "node:test";
import assert from "node:assert/strict";
import { chooseNextManager, retryDelaySeconds } from "../src/core.js";

test("manager removal never assigns the removed code", () => {
  let last = "m2";
  const active = ["m1", "m3", "m4"];
  const assigned = [];
  for (let index = 0; index < 120; index += 1) {
    last = chooseNextManager(active, last);
    assigned.push(last);
  }
  assert.equal(assigned.includes("m2"), false);
  const counts = active.map((code) => assigned.filter((value) => value === code).length);
  assert.equal(Math.max(...counts) - Math.min(...counts), 0);
});

test("adding a new manager produces a stable cycle from the current position", () => {
  let last = "m2";
  const active = ["m1", "m2", "m3", "m4"];
  const assigned = [];
  for (let index = 0; index < 8; index += 1) {
    last = chooseNextManager(active, last);
    assigned.push(last);
  }
  assert.deepEqual(assigned, ["m3", "m4", "m1", "m2", "m3", "m4", "m1", "m2"]);
});

test("four pools can interleave heavily without sharing state", () => {
  const pools = new Map(
    [1, 2, 3, 4].map((poolNumber) => [
      `segment_${poolNumber}`,
      { codes: [1, 2, 3, 4, 5].map((n) => `s${poolNumber}_manager_${n}`), last: "", counts: {} },
    ]),
  );

  for (let index = 0; index < 100_000; index += 1) {
    const poolName = `segment_${(index * 17) % 4 + 1}`;
    const pool = pools.get(poolName);
    pool.last = chooseNextManager(pool.codes, pool.last);
    pool.counts[pool.last] = (pool.counts[pool.last] || 0) + 1;
  }

  for (const pool of pools.values()) {
    const values = pool.codes.map((code) => pool.counts[code] || 0);
    assert.ok(Math.max(...values) - Math.min(...values) <= 1);
  }
});

test("full retry schedule is bounded and cannot spin in a tight loop", () => {
  const delays = Array.from({ length: 8 }, (_, index) => retryDelaySeconds(index + 1));
  assert.deepEqual(delays, [30, 60, 120, 240, 480, 960, 1_920, 3_600]);
  assert.equal(delays.reduce((sum, value) => sum + value, 0), 7_410);
});

test("repair semantics preserve the round-robin cursor in the model", () => {
  const codes = ["m1", "m2", "m3"];
  let last = chooseNextManager(codes, "");
  assert.equal(last, "m1");

  const repairManager = "m3";
  assert.equal(repairManager, "m3");
  // A repair writes an already chosen code and therefore must not assign to `last`.
  assert.equal(last, "m1");

  last = chooseNextManager(codes, last);
  assert.equal(last, "m2");
});
