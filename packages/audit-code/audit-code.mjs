#!/usr/bin/env node

import { runAuditCodeWrapper } from "./audit-code-wrapper-lib.mjs";

try {
  await runAuditCodeWrapper({
    usageName: "audit-code.mjs",
    ensureArtifactsDir: true,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
