/**
 * The minimal candidate-step driver `tests/audit/systemic-round-identity.test.ts`
 * drives the real `next-step` emission scaffold with.
 *
 * WHY THIS EXISTS. That test covers a PRODUCT property — a systemic-challenge
 * submission binds to accepted round progress, so re-emitting a pending round
 * preserves its bound result path while accepted non-empty progress mints the
 * next one. It observes the property through a candidate driver that refuses a
 * repeated emitted step identity. Until 2026-09-10 that driver was borrowed from
 * the P0 benchmark runner, which tied a product test to a harness. The benchmark
 * track was retired (owner decision 2026-09-10) and its runner deleted; the two
 * functions the test actually needs moved here, behaviour unchanged, so the
 * assertion keeps its subject and the test tree keeps no dependency on a tree
 * that no longer exists.
 *
 * SCOPE, stated: identity derivation, the repeat guard, and the loop that applies
 * them. Nothing benchmark-specific survives — no manifest, no scoring, no
 * prepared-request binding. The retired runner's request builder also carried a
 * prepared-candidate-request branch; nothing here asks for it, so it is not
 * carried over rather than kept as dead code.
 *
 * Steps are read STRUCTURALLY (`step_id`, `step_kind`, `artifact_paths`,
 * `status`, `stop_condition`): the emitted contract is the subject under test,
 * never a type this helper gets to pin.
 */
import { createHash } from "node:crypto";

/** An emitted step contract, read structurally. */
type CandidateStep = Record<string, any>;

const isObj = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isStr = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const digest = (value: unknown): string =>
  createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");

/**
 * A step's identity: its own `step_id` when it carries one, otherwise a digest
 * over the content-derived fields. `current_step` / `current_prompt` are
 * excluded — they name where the step is WRITTEN, so including them would make
 * every re-emission of the same pending round look like a new one.
 */
function stepIdentity(step: CandidateStep): string {
  if (!isObj(step) || (!isStr(step.step_id) && !isStr(step.step_kind)))
    throw Error("missing or malformed current step");
  if (isStr(step.step_id)) return step.step_id;
  const artifact_paths = Object.fromEntries(
    Object.entries(isObj(step.artifact_paths) ? step.artifact_paths : {})
      .filter(
        ([key, value]) =>
          !["current_step", "current_prompt"].includes(key) && isStr(value),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${step.step_kind}:${digest({
    artifact_paths,
    run_id: step.run_id ?? null,
    step_kind: step.step_kind,
    stop_condition: step.stop_condition ?? null,
  }).slice(0, 24)}`;
}

/** The repeat guard: an identity already seen is a non-advancing loop. */
function assertStep(step: CandidateStep, seen: Set<string>): void {
  const identity = stepIdentity(step);
  if (seen.has(identity))
    throw Error("non-advancing or repeated step identity");
  seen.add(identity);
}

function terminal(step: CandidateStep): boolean {
  return (
    step.complete === true ||
    (step.step_kind === "present_report" && step.status === "complete")
  );
}

/** Bind a step's derived identity and terminal artifact onto the step itself. */
export function bindCandidateTerminalStep(step: CandidateStep): CandidateStep {
  const artifactPaths = isObj(step?.artifact_paths) ? step.artifact_paths : {};
  const artifact_path = isStr(step?.artifact_path)
    ? step.artifact_path
    : isStr(artifactPaths.final_report)
      ? artifactPaths.final_report
      : isStr(artifactPaths.audit_report)
        ? artifactPaths.audit_report
        : undefined;
  return {
    ...step,
    step_id: stepIdentity(step),
    artifact_path,
    complete: step?.complete === true || step?.status === "complete",
  };
}

function stepRequest(
  step: CandidateStep,
  prompt: unknown,
  snapshot_root: unknown,
  pinned_profile: unknown,
): Record<string, unknown> {
  const step_id = stepIdentity(step);
  if (!isStr(prompt)) throw Error(`missing prompt for step ${step_id}`);
  return {
    step_id,
    step_kind: step.step_kind,
    prompt,
    artifact_path: step.artifact_path,
    artifact_paths: step.artifact_paths,
    access: step.access,
    allowed_commands: step.allowed_commands,
    status: step.status,
    stop_condition: step.stop_condition,
    snapshot_root,
    pinned_profile,
  };
}

/**
 * Drive a candidate to a terminal step, refusing a repeated identity on the way.
 * `nextStep` and `executePrompt` are seams: the caller supplies the real
 * emission and whatever stands in for execution.
 */
export async function driveCandidateLoop({
  snapshot_root,
  pinned_profile,
  maxSteps = 20,
  nextStep,
  executePrompt,
}: {
  snapshot_root: unknown;
  pinned_profile: unknown;
  maxSteps?: number;
  nextStep: () => CandidateStep | Promise<CandidateStep>;
  executePrompt: (request: Record<string, unknown>) => unknown;
}): Promise<{ step: CandidateStep; steps: number }> {
  if (typeof nextStep !== "function" || typeof executePrompt !== "function")
    throw Error("loop seams required");
  const seen = new Set<string>();
  let last: CandidateStep | undefined;
  for (let steps = 1; steps <= maxSteps; steps += 1) {
    const step = await nextStep();
    assertStep(step, seen);
    last = step;
    if (terminal(step)) return { step, steps };
    await executePrompt(
      stepRequest(step, step.prompt, snapshot_root, pinned_profile),
    );
  }
  throw Error(
    `max-step exhaustion after ${maxSteps} steps; last=${last ? stepIdentity(last) : "none"}`,
  );
}
