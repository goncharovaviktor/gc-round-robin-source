import { readFile } from "node:fs/promises";
import { MANAGER_CONFIG } from "../src/manager-config.js";
import { validateManagerConfiguration } from "../src/core.js";

const configText = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const config = JSON.parse(configText);
const errors = [];
const allowTemplateDefaults = process.env.ALLOW_TEMPLATE_DEFAULTS === "1";

if (!/^https:\/\/[^\s/]+$/i.test(config.vars?.GC_BASE_URL || "")) {
  errors.push("GC_BASE_URL must contain only the HTTPS school origin without a path or trailing slash.");
}
if (!allowTemplateDefaults && /YOUR-SCHOOL/i.test(config.vars?.GC_BASE_URL || "")) {
  errors.push("Replace YOUR-SCHOOL in GC_BASE_URL.");
}
const databaseId = config.d1_databases?.[0]?.database_id || "";
if (!allowTemplateDefaults && databaseId === "00000000-0000-0000-0000-000000000000") {
  errors.push("Replace the placeholder D1 database_id.");
}
if (!allowTemplateDefaults && config.vars?.MANAGER_CONFIG_READY !== "true") {
  errors.push("Set MANAGER_CONFIG_READY to true only after checking src/manager-config.js.");
}
if (config.d1_databases?.[0]?.binding !== "RR_DB") errors.push("D1 binding must be RR_DB.");
if (config.durable_objects?.bindings?.[0]?.name !== "POOL_ALLOCATOR") {
  errors.push("Durable Object binding must be POOL_ALLOCATOR.");
}
if (!config.queues?.producers?.some((item) => item.binding === "GC_WRITE_QUEUE")) {
  errors.push("GC_WRITE_QUEUE producer binding is missing.");
}
if (!config.queues?.producers?.some((item) => item.binding === "GC_WRITE_DLQ")) {
  errors.push("GC_WRITE_DLQ producer binding is missing.");
}
if (config.queues?.consumers?.[0]?.max_concurrency !== 1) {
  errors.push("Queue max_concurrency must remain 1 for controlled GetCourse API writes.");
}
if (!config.queues?.consumers?.some((item) => item.queue === "gc-manager-rr-dlq")) {
  errors.push("The dead-letter queue consumer is missing.");
}

const managerConfiguration = validateManagerConfiguration(MANAGER_CONFIG);
if (!managerConfiguration.ok) {
  errors.push(`Manager configuration is invalid: ${managerConfiguration.error}.`);
}

if (errors.length) {
  console.error("CONFIGURATION CHECK FAILED:\n- " + errors.join("\n- "));
  process.exitCode = 1;
} else {
  console.log("CONFIGURATION CHECK PASSED");
}
