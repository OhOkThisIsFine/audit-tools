// Vitest runs this setup for each test file. The directories isolate both
// in-process lookups and spawned CLIs from the machine's real audit state
// and installed tools. Keep them inside the invocation root: worker exits
// (including worker-thread termination) do not reliably run exit listeners.
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

const runRoot = process.env.AUDIT_TOOLS_TEST_RUN_ROOT;
if (!runRoot) throw new Error("Vitest global setup did not create the audit-tools test root.");
const fixtureRoot = mkdtempSync(join(runRoot, "worker-fixtures-"));
// Contain the remaining mkdtemp(tmpdir()) fixtures and temporary writes by
// spawned CLIs too. POSIX prefers TMPDIR; Windows prefers TEMP then TMP.
process.env.TMPDIR = fixtureRoot;
process.env.TEMP = fixtureRoot;
process.env.TMP = fixtureRoot;
for (const [key, name] of [
  ["AUDIT_CODE_STATE_DIR", "state"],
  ["AUDIT_TOOLS_ANALYZER_CACHE", "analyzer-cache"],
  ["AUDIT_TOOLS_BINARY_CACHE", "binary-cache"],
]) {
  const dir = join(fixtureRoot, name);
  mkdirSync(dir);
  process.env[key] = dir;
}
