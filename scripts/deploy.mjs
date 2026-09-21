import { spawn } from "node:child_process";
import { deployWithAutomaticProvisioning } from "./deploy-core.mjs";

function runWrangler(argumentsList) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(executable, ["--no-install", "wrangler", ...argumentsList], {
      stdio: "inherit",
      shell: false,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `Wrangler was terminated by signal ${signal}.`
            : `Wrangler exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

try {
  await deployWithAutomaticProvisioning({ runWrangler });
} catch (error) {
  console.error("DEPLOYMENT FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
