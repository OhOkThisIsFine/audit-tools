// Machine-global state-dir hermeticity for smoke scripts — the scripts/ twin of
// tests/helpers/state-dir-setup.mjs (vitest setupFiles can't cover standalone
// node programs). Importing this module points AUDIT_CODE_STATE_DIR at a fresh
// temp dir before any CLI child is spawned, so no smoke outcome can depend on
// the box's live ~/.audit-code / ~/.remediate-code (declaration, populate
// cache, quota ledger, reservations). Single-sourced resolution lives in
// src/shared/io/stateDir.ts; every smoke child inherits process.env.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "audit-tools-smoke-state-"));
process.env.AUDIT_CODE_STATE_DIR = stateDir;

process.on("exit", () => {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; the OS temp dir is the backstop.
  }
});
