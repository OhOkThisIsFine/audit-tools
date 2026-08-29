// Vitest setupFile: machine-global state-dir hermeticity for the whole suite.
//
// Every e2e/wrapper test spawns the real CLIs, and every CLI
// invocation resolves the machine-global state dir (`~/.audit-code`:
// sources-declared.json, quota-state.json, reservations.json). Without this
// override a box with declared sources leaks that state into EVERY child process.
//
// Setting AUDIT_CODE_STATE_DIR here redirects every reader/writer (single-sourced
// in src/shared/io/stateDir.ts) to a fresh temp dir, both in-process and in every
// spawned child (all spawn helpers inherit/spread process.env). setupFiles run per
// worker, so each test file gets its own dir. Always overrides — hermeticity must
// not depend on the invoking shell's environment.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "audit-tools-test-state-"));
process.env.AUDIT_CODE_STATE_DIR = stateDir;

// Same hermeticity for the analyzer-dependency cache (~/.audit-tools/
// analyzer-cache, single-sourced in src/shared/tooling/analyzerDeps.ts):
// a box whose cache holds typescript@5 resolves analyzers other machines
// report absent, so a test can go green here and red on CI. Every test sees
// an EMPTY per-worker cache; a test that wants a populated cache builds one
// and passes its own cacheRoot.
const analyzerCache = mkdtempSync(join(tmpdir(), "audit-tools-test-analyzer-cache-"));
process.env.AUDIT_TOOLS_ANALYZER_CACHE = analyzerCache;

process.on("exit", () => {
  for (const dir of [stateDir, analyzerCache]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the OS temp dir is the backstop.
    }
  }
});
