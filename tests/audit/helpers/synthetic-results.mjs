import { assertNonEmptyString, assertStringArray, describeValue, fail, isRecord } from "./validate.mjs";
import { buildSyntheticResults as buildSyntheticResultsImpl } from "../../../scripts/audit/smoke-audit-flow.mjs";

export function validatePendingTask(task, index) {
  if (!isRecord(task)) {
    fail(`pending task ${index} must be an object, got ${describeValue(task)}.`);
  }
  assertNonEmptyString(task.task_id, `pending task ${index}.task_id`);
  assertNonEmptyString(task.unit_id, `pending task ${index}.unit_id`);
  assertNonEmptyString(task.pass_id, `pending task ${index}.pass_id`);
  assertNonEmptyString(task.lens, `pending task ${index}.lens`);
  assertStringArray(task.file_paths, `pending task ${index}.file_paths`);
}

/**
 * Synthesize one AuditResult per assigned task — by calling the PRODUCTION
 * producer, never by re-building the payload here.
 *
 * This file used to hand-build the AuditResult: the same field list, the same
 * `countLines` call, the same `reviewed_clean` affirmation as
 * `scripts/audit/smoke-audit-flow.mjs`. It was the SECOND AuditResult
 * construction site in the repo, and `tests/audit/smoke-producer-contract.test.ts`
 * documents exactly what that class costs: when `reviewed_clean` joined the
 * contract, the `scripts/` producer was missed by a `tests/**` fixture sweep and
 * failed release CI. The fix there was to make the producer validate its own
 * output. The same fix applies here, and it is simpler: there is one producer,
 * and this calls it.
 *
 * The delegation is not cosmetic. A hand-built copy cannot fail on a contract it
 * never consults — it goes on producing the old shape silently, and the test
 * that consumes it goes on passing against a payload the tool would reject.
 *
 * `tests/shared/test-mirrors-production.test.ts` is the invariant that keeps a
 * third construction site from appearing.
 */
export async function buildSyntheticResults(tasks, root) {
  tasks.forEach((task, index) => validatePendingTask(task, index));
  return buildSyntheticResultsImpl(tasks, root, "test-fixture");
}
