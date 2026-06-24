import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "./json.js";

/**
 * Tool-emitted end-of-run friction capture, single-sourced for BOTH orchestrators
 * (audit-code + remediate-code) so the artifact shape, filename, persist helper,
 * and "already captured?" check cannot drift between the two halves of the
 * pipeline. The host (the active LLM agent) owns ONLY the friction CONTENT; the
 * tool owns the structure, the filename, the per-run `run_id` key, and the
 * `schema_version`.
 *
 * Properties this module guarantees (the obligation that drives the close-out
 * lives in each orchestrator's nextStep; this is the shared substrate):
 *  - DETERMINISTIC: the persist + the "captured?" probe are pure file ops keyed
 *    only off `(artifactsDir, run_id)`, never host discretion.
 *  - PARITY: one shape, one helper — both orchestrators import the same code, so
 *    a divergent spelling is impossible.
 *  - DEGRADE-CLEANLY: a run with ZERO frictions still writes a valid artifact
 *    (`frictions: []`) and counts as captured, so the close-out never blocks
 *    completion.
 *  - NEVER RE-LOOP: once an artifact exists for a `run_id`, `frictionCaptured`
 *    is true and the obligation short-circuits — the close-out fires at most once
 *    per run.
 *  - OS/PATH-AGNOSTIC: every path derives from `node:path` joins off the supplied
 *    artifacts dir, never a platform-baked literal.
 *
 * This module NEVER references a specific project's docs/backlog.md: the friction
 * artifact is a per-project, per-run record under the run's own artifacts dir; it
 * is not coupled to any one repository's tracking doc.
 */

export const FRICTION_CAPTURE_SCHEMA_VERSION = "friction-capture/v1alpha1";

/** Subdirectory under the artifacts dir holding per-run friction records. */
export const FRICTION_CAPTURE_DIRNAME = "friction";

/** One friction item the host recorded. Only `note` is required. */
export interface FrictionItem {
  /** Free-form description of the friction hit this run. */
  note: string;
  /** Optional severity hint, host-supplied. */
  severity?: "info" | "low" | "medium" | "high";
  /** Optional category: a bug/defect vs. a standing environment/tooling trap. */
  category?: "bug" | "trap" | "suggestion";
  /** Optional path/area the friction relates to. */
  area?: string;
}

/** The per-run friction artifact. The tool owns every field except `frictions`. */
export interface FrictionCaptureArtifact {
  schema_version: typeof FRICTION_CAPTURE_SCHEMA_VERSION;
  /** Which orchestrator emitted this record. */
  tool: "audit-code" | "remediate-code";
  /** Per-project run id this close-out belongs to. */
  run_id: string;
  /** ISO timestamp the record was persisted. */
  captured_at: string;
  /** Host-supplied friction content; an empty array is the clean-degrade case. */
  frictions: FrictionItem[];
}

/** `<artifactsDir>/friction` — where per-run friction records live (absolute). */
export function frictionCaptureDir(artifactsDir: string): string {
  return join(artifactsDir, FRICTION_CAPTURE_DIRNAME);
}

/**
 * `<artifactsDir>/friction/<run_id>.json` — the per-run, run_id-keyed friction
 * record path. The run_id is sanitized to a filename-safe token so an arbitrary
 * run id (plan ids, ledger run ids) never escapes the friction dir or collides
 * with path separators across OSes.
 */
export function frictionCapturePath(artifactsDir: string, runId: string): string {
  return join(frictionCaptureDir(artifactsDir), `${sanitizeRunId(runId)}.json`);
}

/** Reduce a run id to a stable, filename-safe token (OS-agnostic). */
export function sanitizeRunId(runId: string): string {
  const cleaned = runId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "run";
}

/**
 * Whether this run's friction close-out has already been captured. Pure read; a
 * record present (even with zero frictions) means the close-out fired — the
 * obligation must short-circuit so it never re-loops.
 */
export async function frictionCaptured(
  artifactsDir: string,
  runId: string,
): Promise<boolean> {
  const existing = await readOptionalJsonFile<FrictionCaptureArtifact>(
    frictionCapturePath(artifactsDir, runId),
  );
  return existing !== undefined && existing !== null;
}

/**
 * Persist the per-run friction artifact via a SINGLE shared atomic write
 * (`writeJsonFile` is temp-then-rename). The tool stamps `schema_version`,
 * `run_id`, `tool`, and `captured_at`; the caller supplies only the
 * host-recorded `frictions` (defaulting to `[]` for the clean-degrade case).
 * Idempotent enough for a close-out: re-persisting overwrites the same run_id
 * record atomically.
 */
export async function persistFrictionCapture(params: {
  artifactsDir: string;
  runId: string;
  tool: FrictionCaptureArtifact["tool"];
  frictions?: FrictionItem[];
}): Promise<FrictionCaptureArtifact> {
  const artifact: FrictionCaptureArtifact = {
    schema_version: FRICTION_CAPTURE_SCHEMA_VERSION,
    tool: params.tool,
    run_id: params.runId,
    captured_at: new Date().toISOString(),
    frictions: params.frictions ?? [],
  };
  await writeJsonFile(frictionCapturePath(params.artifactsDir, params.runId), artifact);
  return artifact;
}
