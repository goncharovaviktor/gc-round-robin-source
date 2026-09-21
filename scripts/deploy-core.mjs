const DEFAULT_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000]);

export async function deployWithAutomaticProvisioning({
  runWrangler,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  log = console,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
} = {}) {
  if (typeof runWrangler !== "function") {
    throw new TypeError("runWrangler must be a function.");
  }

  log.info("[1/2] Deploying Worker and automatically provisioning Cloudflare resources...");
  await runWrangler(["deploy"]);

  const maximumAttempts = retryDelaysMs.length + 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      log.info(`[2/2] Applying D1 migrations (attempt ${attempt}/${maximumAttempts})...`);
      await runWrangler(["d1", "migrations", "apply", "RR_DB", "--remote"]);
      log.info("Deployment and D1 migrations completed successfully.");
      return { migrationAttempts: attempt };
    } catch (error) {
      if (attempt === maximumAttempts) throw error;
      const delay = retryDelaysMs[attempt - 1];
      log.warn(`D1 migration attempt ${attempt} failed; retrying in ${delay / 1_000}s.`);
      await sleep(delay);
    }
  }

  throw new Error("Unreachable deployment state.");
}
