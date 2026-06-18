#!/usr/bin/env node
// Single-package postinstall: deploy BOTH the audit-code and remediate-code host
// assets (global slash commands, Codex/OpenCode/Antigravity skills, plugin
// manifests). Each sub-deployer is self-contained — it computes its own package
// root, skips optional steps when the shared dist isn't built yet (fresh `npm ci`),
// and exits non-zero only on a real partial-deploy failure (e.g. a blocked write
// target). We run both as isolated child processes so one host's deployment never
// corrupts the other's, and surface a non-zero exit if EITHER reports a failure
// (INV-remediate-infra-08: a partial deploy must not report success).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failed = false;
for (const script of ["./audit/postinstall.mjs", "./remediate/postinstall.mjs"]) {
  const scriptPath = fileURLToPath(new URL(script, import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], { stdio: "inherit" });
  if (result.error) {
    console.warn(`[audit-tools] postinstall: ${script} could not run (${result.error.message}).`);
    failed = true;
  } else if ((result.status ?? 0) !== 0 || result.signal) {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
