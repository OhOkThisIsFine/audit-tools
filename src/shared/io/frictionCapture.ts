import { join } from "node:path";
import { createHash } from "node:crypto";
import { cp, readdir } from "node:fs/promises";
import { readOptionalJsonFile } from "./json.js";
import { discardOnSchemaVersionMismatch } from "./schemaVersion.js";

/**
 * Tool-emitted end-of-run friction capture, single-sourced for BOTH orchestrators
 * (audit-code + remediate-code) so the artifact shape, filename, path derivation,
 * and "already captured?" check cannot drift between the two halves of the
 * pipeline. The host (the active LLM agent) owns ONLY the friction CONTENT; the
 * tool owns the structure, the filename, the per-run `run_id` key, and the
 * `schema_version`.
 *
 * Properties this module guarantees (the obligation that drives the close-out
 * lives in each orchestrator's nextStep; this is the shared substrate):
 *  - DETERMINISTIC: the path derivation and the "captured?" probe are pure file
 *    ops keyed only off `(artifactsDir, run_id)`, never host discretion.
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

/**
 * The runs a friction record RELATES to, named by reference. THE contract statement for
 * the linkage — every other site (the merge, the writer seam, the by-reference reader,
 * the call sites) points here rather than restating it.
 *
 * Three run notions coexist and their lifecycles genuinely differ — the step-envelope
 * run on the step contract, the host-handoff (dispatch) run, and the record's own
 * `run_id` key — so they are NOT collapsed into one identity. What the record owes is
 * VISIBILITY of the relation: a reader holding a dispatch run id must be able to tell
 * which friction record it belongs to instead of guessing at the key.
 *
 * Both fields are ALWAYS PRESENT reference ARRAYS, empty when nothing is recorded — so
 * "no relation recorded" is a stated answer rather than an absent key.
 *
 * They are arrays because the relation is genuinely ONE-TO-MANY: one record can span
 * many rounds (audit keys its record by a fixed literal for the whole session, while
 * `ensureSemanticReviewRun` re-mints a review/dispatch run id per round). A scalar would
 * be first-writer-wins and hide rounds 2..N — the very invisibility this linkage exists
 * to close. So the merge ACCUMULATES: a supplied id is appended if new, never replaces
 * one already present, and no writer can drop one. Entries are deduped and held in
 * code-unit order of the id itself, never write order, so the array stays content-ordered.
 *
 * The two arrays are independent SETS, NOT positionally paired: content order discards
 * write order, so which step run accompanied which dispatch run in a given round is not
 * recoverable from the record. Never zip them.
 *
 * The rule for what may be written is PROVENANCE, not distinctness: a writer may record a
 * reference only from the envelope that owns it, and records nothing for one it does not
 * hold — it may never synthesize a reference out of `run_id` or out of the other
 * reference. Value COINCIDENCE is permitted and is in fact today's state on both draws:
 * on remediate all three ids resolve to the same value at the dispatch seam, and on audit
 * both references are the active review run. The reference is written anyway so the
 * relation survives if the lifecycles diverge, which they may — an early-lifecycle step
 * mints its own envelope run. Never assume the values differ; only that each was sourced,
 * not invented.
 */
export interface FrictionRunLinks {
  /**
   * Every step-envelope `run_id` (the step contract's own run key, see
   * `stepContractWriter.ts`) this record relates to. Lifecycle: one step contract,
   * rewritten every next-step call. Empty when no envelope run was recorded.
   */
  step_run_ids: readonly string[];
  /**
   * Every host-handoff run id this record relates to — the run keys the dispatch
   * workload, task bindings, and result map are filed under. Lifecycle: one dispatch
   * round, outliving the step contract that published it. Empty when no dispatch round
   * was ever in scope for this record.
   */
  dispatch_run_ids: readonly string[];
}

/**
 * ONE write against {@link FrictionRunLinks}: the single step run and/or dispatch run the
 * writing seam holds this round. An omitted key or an explicit `null` records nothing on
 * that axis; a supplied id accumulates into the corresponding array. Also the query shape
 * for the by-reference reader, which matches on MEMBERSHIP of the supplied id.
 */
export interface FrictionRunLinkUpdate {
  readonly step_run_id?: string | null;
  readonly dispatch_run_id?: string | null;
}

/** The per-run friction artifact. The tool owns every field except `frictions`. */
export interface FrictionCaptureArtifact extends FrictionRunLinks {
  schema_version: typeof FRICTION_CAPTURE_SCHEMA_VERSION;
  /** Which orchestrator emitted this record. */
  tool: "audit-code" | "remediate-code";
  /** Per-project run id this close-out belongs to — this record's OWN key. */
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
  // Discarded on mismatch, not merged. This artifact ACCUMULATES across a run, so
  // folding an older-schema file into the current one would silently corrupt the
  // accumulation; the notes are diagnostic, so losing a stale-shaped file is the
  // cheaper failure. An absent file and a stale file behave identically here.
  const existing = discardOnSchemaVersionMismatch(
    await readOptionalJsonFile<FrictionCaptureArtifact>(
      frictionCapturePath(artifactsDir, runId),
    ),
    FRICTION_CAPTURE_SCHEMA_VERSION,
  );
  return existing !== undefined && existing !== null;
}

/**
 * Archive every per-run friction record out of `<artifactsDir>/friction/` into
 * `destDir` as `<prefix>-<basename>` (e.g. `audit-friction-run.json`), returning
 * the archived destination paths. The friction record must outlive terminal
 * cleanup: both orchestrators' completion paths rm the whole artifacts dir, and
 * before this helper existed that destroyed the close-out walk the tool itself
 * had just enforced, with no consumer having read it (2026-08-05 + 2026-08-06
 * dogfoods). Callers invoke it immediately BEFORE the terminal rm so the record
 * rides along with the promoted deliverables. Best-effort per file: a failed
 * copy is reported through `warn` and never blocks completion (parity with the
 * promoted-findings copy).
 */
export async function archiveFrictionRecords(params: {
  artifactsDir: string;
  destDir: string;
  prefix: string;
  copyFile?: typeof cp;
  warn?: (message: string) => void;
}): Promise<string[]> {
  const copyFile = params.copyFile ?? cp;
  const warn = params.warn ?? ((message) => process.stderr.write(`${message}\n`));
  const dir = frictionCaptureDir(params.artifactsDir);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return []; // no friction dir → nothing to archive
  }
  const archived: string[] = [];
  for (const name of names) {
    const destination = join(params.destDir, `${params.prefix}-${name}`);
    try {
      await copyFile(join(dir, name), destination, { force: true });
      archived.push(destination);
    } catch (error) {
      warn(
        `could not archive friction record ${name} to ${destination}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return archived;
}
