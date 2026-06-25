#!/usr/bin/env node

import { runAuditCodeWrapper } from "./wrapper/audit-code-wrapper-lib.mjs";

try {
  await runAuditCodeWrapper({
    usageName: "audit-code.mjs",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
