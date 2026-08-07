// ── Single-writer contract for active-dispatch.json ──────────────────────────
//
// `paused_state` ⊕ `partial_completion_terminal` (the CP-NODE-6 asymmetric
// ratchet) is enforced by pausePersist.ts's locked store — but only if EVERY
// writer of active-dispatch.json rides it. Three lockless bypass writers were
// found and removed (prepare's whole-artifact rebuild, force-synthesis's
// overlay, merge-and-ingest's status flip); this guard keeps the set closed:
// outside pausePersist.ts, no file under src/ may write the artifact or build
// the store that owns it.
//
// COVERAGE STATED HONESTLY (a partly-enforced trap must name its uncovered
// half): the scan matches a direct write call whose nearby argument text names
// ACTIVE_DISPATCH_FILENAME / the "active-dispatch.json" literal — the shape
// every historical bypass took. A writer that aliases the constant into a
// distant variable, or receives the path as data, evades it; review still owns
// that half.

import { test, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..", "..", "src");
const SANCTIONED_WRITER = "audit/cli/dispatch/pausePersist.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const WRITE_CALLEES = ["writeJsonFile", "writeFileSync", "writeFile", "appendFileSync", "appendFile"];
const ARTIFACT_TOKENS = ["ACTIVE_DISPATCH_FILENAME", '"active-dispatch.json"'];
// A write call's argument window — comfortably covers the multi-line
// `writeJsonFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), value)` shapes
// the removed bypasses used.
const ARG_WINDOW_CHARS = 200;

test("no file outside pausePersist.ts writes active-dispatch.json (single-writer contract)", () => {
  const violations: string[] = [];
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
    if (rel === SANCTIONED_WRITER) continue;
    const source = readFileSync(file, "utf8");
    for (const callee of WRITE_CALLEES) {
      const callRe = new RegExp(`(?<![.\\w$])${callee}\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(source)) !== null) {
        const window = source.slice(m.index, m.index + ARG_WINDOW_CHARS);
        if (ARTIFACT_TOKENS.some((token) => window.includes(token))) {
          const line = source.slice(0, m.index).split("\n").length;
          violations.push(`${rel}:${line} — ${callee}(...) targeting active-dispatch.json`);
        }
      }
    }
  }
  expect(
    violations,
    "active-dispatch.json has ONE sanctioned writer (pausePersist.ts's locked store). " +
      "Route new transitions through its ops (persistPausedState / clearPausedState / " +
      "recordPartialCompletionTerminal / replaceActiveDispatchForRun / " +
      "recordOperatorForcedTerminalState / markDispatchStatus) — a direct write " +
      "reintroduces the read↔write interleave that erased stamped terminals. Violations:\n" +
      violations.join("\n"),
  ).toEqual([]);
});

test("the active-dispatch locked store is built in exactly one module (pausePersist.ts owns the lock)", () => {
  const holders: string[] = [];
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
    if (readFileSync(file, "utf8").includes("active-dispatch.lock")) holders.push(rel);
  }
  expect(holders, "the store (and its lock filename) must stay single-homed in pausePersist.ts").toEqual([
    SANCTIONED_WRITER,
  ]);
});
