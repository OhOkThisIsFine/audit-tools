// Per-INVOCATION scratch roots for test fixture trees.
//
// Two defects this exists to make unrepresentable:
//
//   (a) In-tree residue. Fixture trees written under `tests/remediate/.test-*/`
//       leave the working tree dirty after a run, so `git add -A` sweeps test
//       residue into a commit — and a dir that a LATER run deleted stages as an
//       `AD` phantom deletion. A `.gitignore` rule was only ever a stopgap: it
//       hides the residue instead of not creating it, and it makes working-tree
//       cleanliness a function of whether tests have run.
//
//   (b) Concurrent-run collision. Rooting fixtures at a FIXED path — in-tree or
//       a constant `tmpdir()/audit-tools-tests` — means two `vitest run`
//       invocations share every fixture dir and race. One observed incident
//       produced 61 failures across 6 files in areas the diff never touched;
//       both areas passed cleanly on a serial re-run, twice. That reads as a
//       damning regression to anyone who does not happen to re-run serially.
//
// The root is created once per invocation by `tests/helpers/global-setup.ts` and
// published on `AUDIT_TOOLS_TEST_RUN_ROOT`; vitest workers inherit it, so every
// file in ONE run shares a root while two concurrent runs cannot see each other.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_RUN_ROOT_ENV = "AUDIT_TOOLS_TEST_RUN_ROOT";

function runRoot(): string {
  const declared = process.env[TEST_RUN_ROOT_ENV];
  if (declared) return declared;
  // No globalSetup ran — a helper imported by a bare `node` script, or a vitest
  // config that forgot the hook. Degrade to a private root rather than to the
  // repo tree: an unisolated fallback would silently reintroduce (a).
  const fallback = mkdtempSync(join(tmpdir(), "audit-tools-tests-orphan-"));
  process.env[TEST_RUN_ROOT_ENV] = fallback;
  return fallback;
}

/**
 * Absolute path to a fixture directory for this invocation.
 *
 * @param name Scratch dir name, unique per test FILE (e.g. ".test-io"). Two
 *   files sharing a name still collide inside one run — the run root isolates
 *   invocations from each other, not files from each other.
 */
export function scratchDir(name: string): string {
  return join(runRoot(), name);
}
