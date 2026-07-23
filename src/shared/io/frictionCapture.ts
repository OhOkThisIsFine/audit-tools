import { join } from "node:path";
import { createHash } from "node:crypto";
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

/**
 * Encode a run id to a stable, filename-safe, OS-agnostic token that is
 * INJECTIVE: distinct run ids ALWAYS map to distinct tokens, so distinct runs
 * never collide on the same friction artifact path.
 *
 * Each character outside the safe set `[A-Za-z0-9._-]` is percent-encoded
 * (`_xx`, hex of its UTF-8 bytes), and a literal `_` is itself escaped (`_5f`)
 * so the encoding is unambiguously reversible. A naive `replace(/.../, "-")`
 * collapse is many-to-one (`a/b` and `a-b` both → `a-b`); this is one-to-one.
 *
 * The empty run id encodes to the reserved sentinel `_` (which no non-empty id
 * can produce, since a non-empty id always emits at least one char and a bare
 * `_` would have been escaped to `_5f`), preserving a non-empty filename stem.
 *
 * PORTABLE-FILENAME HARDENING (INV-SCC-05 / COR-11e0ff4c) — two further rules:
 *
 *  - RESERVED DEVICE STEMS: Windows reserves `CON`, `PRN`, `AUX`, `NUL`,
 *    `COM1`-`COM9`, `LPT1`-`LPT9` (case-insensitively, keyed off the component
 *    stem BEFORE the first dot — `CON.json` is the CON device). A run id whose
 *    encoded form would be such a stem gets its FIRST character byte-escaped
 *    (`CON` → `_43ON`), which stays injective: normal encoding never emits an
 *    escape for a safe char, and any id literally containing `_` has it escaped
 *    to `_5f...`, so no other id can produce the escaped spelling.
 *
 *  - COMPONENT LENGTH BOUND: filesystems cap a path component at 255 bytes. An
 *    encoded token longer than {@link MAX_RUN_ID_TOKEN_LENGTH} is truncated and
 *    disambiguated with `_` + UPPERCASE-hex SHA-256 of the RAW run id.
 *    Injectivity here is cryptographic (collision-resistant digest) rather than
 *    structural; the uppercase marker cannot collide with any normal encoding,
 *    because normal escapes always emit lowercase hex after `_`.
 */

/** Longest encoded run-id token emitted; `<token>.json` stays well under 255. */
const MAX_RUN_ID_TOKEN_LENGTH = 180;
/** Truncation marker + digest: `_` + 32 uppercase hex chars (128 bits). */
const TRUNCATION_DIGEST_HEX_CHARS = 32;
const WINDOWS_RESERVED_STEM = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

function escapeCharBytes(ch: string): string {
  let out = "";
  for (const byte of Buffer.from(ch, "utf8")) {
    out += "_" + byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function sanitizeRunId(runId: string): string {
  if (runId.length === 0) {
    return "_";
  }
  let out = "";
  for (const ch of runId) {
    if (ch !== "_" && /^[A-Za-z0-9.\-]$/.test(ch)) {
      out += ch;
      continue;
    }
    out += escapeCharBytes(ch);
  }
  // Reserved-device-stem escape: the token becomes `<token>.json`, and Windows
  // keys the reservation off the stem before the first dot, so test the token's
  // own leading stem. Escaping the first character removes the reserved spelling
  // while keeping the mapping one-to-one (see the doc comment).
  if (WINDOWS_RESERVED_STEM.test(out)) {
    out = escapeCharBytes(out[0]!) + out.slice(1);
  }
  // Length bound: truncate + digest-disambiguate (uppercase hex marker — a form
  // no normal encoding can emit, so bounded and unbounded tokens never collide).
  if (out.length > MAX_RUN_ID_TOKEN_LENGTH) {
    const digest = createHash("sha256")
      .update(runId, "utf8")
      .digest("hex")
      .slice(0, TRUNCATION_DIGEST_HEX_CHARS)
      .toUpperCase();
    out = out.slice(0, MAX_RUN_ID_TOKEN_LENGTH - 1 - TRUNCATION_DIGEST_HEX_CHARS) + "_" + digest;
  }
  return out;
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
