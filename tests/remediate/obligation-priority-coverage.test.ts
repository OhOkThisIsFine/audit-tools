/**
 * The remediate draw of the priority/registry coverage contract.
 *
 * Audit pins this property in `tests/audit/executor-registry-sync.test.ts` — one
 * test per direction. Remediate pinned neither, and it had already drifted:
 * `PRE_INTAKE_PRIORITY` listed `report_warning` for two months after the
 * obligation defining it was deleted (`db1f2878`, 2026-06-26). The shared engine
 * SKIPS a priority id that no obligation defines, in silence, so nothing failed —
 * the gate was simply absent on this draw.
 *
 * This is the twin of the audit pair, not a copy of audit's load-time throw.
 * The throw does not port: both remediate builders take a full `RemediateCtx`
 * built per call, and `src/remediate/index.ts` imports this module statically, so
 * an import-time throw would fire before `current-step.json` is written and a
 * stale step would read as live — the exact failure `blocked` exists to prevent.
 * Per CLAUDE.md, enforcement is a hook when detectable at a tool call and a
 * CONTRACT TEST when it is a property of the tree; this is the latter.
 */

import { test, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLogger } from "audit-tools/shared";
import { StateStore } from "../../src/remediate/state/store.js";
import {
  PRE_INTAKE_PRIORITY,
  MAIN_PRIORITY,
  buildPreIntakeObligations,
  buildMainObligations,
  type RemediateCtx,
  type PreIntakeSnapshot,
} from "../../src/remediate/steps/nextStep.js";

/**
 * A real ctx over a real temp dir. The builders close over these paths but never
 * touch the filesystem at BUILD time — only the `derive`/`execute` closures do,
 * and this contract reads ids only. Nothing here is cast, so a shape change in
 * `RemediateCtx` reds this file rather than passing vacuously.
 */
async function buildCtx(): Promise<RemediateCtx> {
  const root = await mkdtemp(join(tmpdir(), "obl-coverage-"));
  const artifactsDir = join(root, ".audit-tools", "remediation");
  return {
    root,
    artifactsDir,
    options: {},
    runLogger: RunLogger.disabled(),
    store: new StateStore(artifactsDir),
    // NB: `RemediateCtx.inputResolution` is the LOCAL `InputResolution` declared
    // in nextStep.ts, not the wider one exported from intakeResolver.ts — the two
    // are separate declarations of the same name and the local one has no
    // `discovered`. Logged as friction; matched here rather than papered over
    // with a cast, so a shape change reds this file.
    inputResolution: {
      supplied: false,
      existing: [],
      allExisting: [],
      missing: [],
      checked: [],
    },
    countStep: async () => {},
  };
}

const EMPTY_SNAPSHOT: PreIntakeSnapshot = {
  existingCheckpoint: undefined,
  resumeAck: undefined,
  entryState: null,
  suppliedInputUnchanged: false,
  guidanceFileSupplied: false,
};

test("every PRE_INTAKE_PRIORITY id is defined by exactly one pre-intake obligation", async () => {
  const ids = buildPreIntakeObligations(await buildCtx(), EMPTY_SNAPSHOT).map(
    (obligation) => obligation.id,
  );
  const undefinedIds = PRE_INTAKE_PRIORITY.filter(
    (id) => !ids.includes(id),
  );
  expect(
    undefinedIds,
    "these ids are listed in PRE_INTAKE_PRIORITY but no obligation defines them, so the engine's " +
      "ordered scan skips them in SILENCE — either define the obligation or drop the id",
  ).toEqual([]);

  const ambiguous = PRE_INTAKE_PRIORITY.filter(
    (id) => ids.filter((candidate) => candidate === id).length > 1,
  );
  expect(ambiguous, "each priority id must map to exactly one obligation").toEqual([]);
});

test("every pre-intake obligation appears in PRE_INTAKE_PRIORITY (an unlisted one is unreachable)", async () => {
  const listed = new Set(PRE_INTAKE_PRIORITY);
  const unreachable = buildPreIntakeObligations(await buildCtx(), EMPTY_SNAPSHOT)
    .map((obligation) => obligation.id)
    .filter((id) => !listed.has(id));
  expect(
    unreachable,
    "these obligations are built but absent from PRE_INTAKE_PRIORITY, so the ordered scan can " +
      "never select them — either list them or delete the registration",
  ).toEqual([]);
});

test("every MAIN_PRIORITY id is defined by exactly one main obligation", async () => {
  const ids = buildMainObligations(await buildCtx()).map((obligation) => obligation.id);
  const undefinedIds = MAIN_PRIORITY.filter((id) => !ids.includes(id));
  expect(
    undefinedIds,
    "these ids are listed in MAIN_PRIORITY but no obligation defines them, so the engine's " +
      "ordered scan skips them in SILENCE — either define the obligation or drop the id",
  ).toEqual([]);

  const ambiguous = MAIN_PRIORITY.filter(
    (id) => ids.filter((candidate) => candidate === id).length > 1,
  );
  expect(ambiguous, "each priority id must map to exactly one obligation").toEqual([]);
});

test("every main obligation appears in MAIN_PRIORITY (an unlisted one is unreachable)", async () => {
  const listed = new Set(MAIN_PRIORITY);
  const unreachable = buildMainObligations(await buildCtx())
    .map((obligation) => obligation.id)
    .filter((id) => !listed.has(id));
  expect(
    unreachable,
    "these obligations are built but absent from MAIN_PRIORITY, so the ordered scan can never " +
      "select them — either list them or delete the registration",
  ).toEqual([]);
});
