import assert from "node:assert/strict";
import test from "node:test";
import { deployWithAutomaticProvisioning } from "../scripts/deploy-core.mjs";

const silentLog = Object.freeze({ info() {}, warn() {} });

test("fresh deployment provisions resources before applying migrations", async () => {
  const calls = [];
  const result = await deployWithAutomaticProvisioning({
    runWrangler: async (argumentsList) => calls.push(argumentsList),
    sleep: async () => assert.fail("sleep must not run on success"),
    log: silentLog,
  });

  assert.deepEqual(calls, [
    ["deploy"],
    ["d1", "migrations", "apply", "RR_DB", "--remote"],
  ]);
  assert.deepEqual(result, { migrationAttempts: 1 });
});

test("temporary migration failures are retried with bounded delays", async () => {
  const calls = [];
  const sleeps = [];
  let migrationAttempt = 0;

  const result = await deployWithAutomaticProvisioning({
    runWrangler: async (argumentsList) => {
      calls.push(argumentsList);
      if (argumentsList[0] === "d1" && ++migrationAttempt < 3) {
        throw new Error("temporary Cloudflare API error");
      }
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    log: silentLog,
    retryDelaysMs: [5, 15],
  });

  assert.equal(calls.filter(([command]) => command === "deploy").length, 1);
  assert.equal(calls.filter(([command]) => command === "d1").length, 3);
  assert.deepEqual(sleeps, [5, 15]);
  assert.deepEqual(result, { migrationAttempts: 3 });
});

test("migration failure remains visible after the bounded retries", async () => {
  let migrationAttempts = 0;
  await assert.rejects(
    deployWithAutomaticProvisioning({
      runWrangler: async ([command]) => {
        if (command === "d1") {
          migrationAttempts += 1;
          throw new Error("migration failed");
        }
      },
      sleep: async () => {},
      log: silentLog,
      retryDelaysMs: [0, 0],
    }),
    /migration failed/,
  );
  assert.equal(migrationAttempts, 3);
});

test("migration is never attempted when the provisioning deploy fails", async () => {
  const calls = [];
  await assert.rejects(
    deployWithAutomaticProvisioning({
      runWrangler: async (argumentsList) => {
        calls.push(argumentsList);
        throw new Error("deploy failed");
      },
      sleep: async () => {},
      log: silentLog,
    }),
    /deploy failed/,
  );
  assert.deepEqual(calls, [["deploy"]]);
});
