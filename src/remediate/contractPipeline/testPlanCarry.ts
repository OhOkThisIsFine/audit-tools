/**
 * Diff-carry for the test-validator plan (C3).
 *
 * Friction: the test-plan is re-derived whole whenever the obligation ledger
 * re-stales (e.g. a repair round changes a module contract). The host then
 * re-authors EVERY spec's assertions — even for obligations whose premise did
 * not change at all.
 *
 * Fix: when a test-plan is ingested, snapshot each authored spec's identity
 * (`name` + `scope_anchors`) plus its assertions, keyed by obligation_id. On a
 * later re-emit, the scaffold pre-fills assertions for every obligation whose
 * premise is unchanged (see `buildTestValidatorPlanScaffold`), so the host only
 * authors the genuinely new/changed specs. Enforced by the tool (the re-emitted
 * skeleton carries the assertions), never left to the host to remember.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "audit-tools/shared";
import { contractPipelineDir } from "./artifactStore.js";
import type { PriorTestSpec } from "./derive.js";

const CARRY_SCHEMA_VERSION =
  "remediate-code-contract-pipeline/test-plan-carry/v1alpha1" as const;

interface TestPlanCarry {
  schema_version: typeof CARRY_SCHEMA_VERSION;
  /** ISO-8601 capture time (caller-supplied for deterministic tests). */
  captured_at: string;
  /** Prior authored spec per obligation_id. */
  specs: Record<string, PriorTestSpec>;
}

export function testPlanCarryPath(artifactsDir: string): string {
  return join(contractPipelineDir(artifactsDir), "test-plan-carry.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string")
    : [];
}

/**
 * Snapshot a freshly-ingested test-plan's authored specs (identity + assertions)
 * keyed by obligation_id, overwriting any prior snapshot. Only specs with at
 * least one assertion are carried (an `inapplicable_claim` spec re-authors).
 */
export async function captureTestPlanCarry(
  artifactsDir: string,
  payload: unknown,
  capturedAt: string,
): Promise<void> {
  const specsArray = isRecord(payload) ? payload.test_specs : undefined;
  if (!Array.isArray(specsArray)) return;
  const specs: Record<string, PriorTestSpec> = {};
  for (const raw of specsArray) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.obligation_id === "string" ? raw.obligation_id : "";
    const name = typeof raw.name === "string" ? raw.name : "";
    const assertions = asStringArray(raw.assertions);
    if (!id || assertions.length === 0) continue;
    specs[id] = {
      name,
      scope_anchors: asStringArray(raw.scope_anchors),
      assertions,
    };
  }
  const carry: TestPlanCarry = {
    schema_version: CARRY_SCHEMA_VERSION,
    captured_at: capturedAt,
    specs,
  };
  await mkdir(contractPipelineDir(artifactsDir), { recursive: true });
  await writeJsonFile(testPlanCarryPath(artifactsDir), carry);
}

/** Read the carried prior specs keyed by obligation_id; empty when none. */
export async function readTestPlanCarry(
  artifactsDir: string,
): Promise<Record<string, PriorTestSpec>> {
  const carry = await readOptionalJsonFile<TestPlanCarry>(
    testPlanCarryPath(artifactsDir),
  );
  return carry?.specs ?? {};
}
