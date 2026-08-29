/**
 * Contract-pipeline repair-state ledger + counterexample waivers.
 *
 * Moved out of steps/contractPipeline.ts (open-bugs.md:108) so every consumer
 * of the ledger — the judge gate that folds and reads waivers, the
 * cross-artifact validation sweep, and the CLI self-check — imports ONE home
 * instead of the steps module re-exporting its private state.
 *
 * The WAIVER lane is the recorded owner-resolution verb the judge escalation
 * used to lack: when the judge↔repair loop stalls on a counterexample the
 * contract schema cannot satisfy, the operator records "accepted as a known
 * limitation" through a tool-named file (`counterexample-waivers.json`) the
 * gate validates, folds into this ledger, and consumes. A waiver lives in the
 * run's artifact tree and dies with the run — per-run choices are never
 * persisted beyond their run. The record carries `waived_by`: like the
 * loop-core review attestation, it is ATTRIBUTABLE, not proof of a human —
 * no mechanical channel can prove who decided, so the record names the
 * decider instead of pretending to verify them.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  isRecord,
  readOptionalJsonFile,
  writeJsonFile,
  type Counterexample,
} from "audit-tools/shared";
import { contractPipelineDir } from "./artifactStore.js";
import { counterexampleFingerprint } from "./counterexampleFingerprint.js";

/** One recorded owner waiver: this counterexample is an accepted limitation of THIS run. */
export interface CounterexampleWaiver {
  /** The counterexample id as the judge report / counterexample artifact names it. */
  ce_id: string;
  /**
   * Content-derived identity (`fp:<fingerprint>`, falling back to `id:<raw>`),
   * computed at fold time — the SAME keying the convergence gate uses, so a
   * waiver survives a re-derived counterexample artifact that re-labels the
   * same claim with a new id. A CHANGED claim gets a new fingerprint and
   * correctly re-surfaces: the waiver bound the claim, not the label.
   */
  key: string;
  /** Why this counterexample is accepted as a limitation. Required, non-empty. */
  rationale: string;
  /** Who decided. Attributable identity, not proof — see the module header. */
  waived_by: string;
  waived_at: string;
}

export interface ContractRepairState {
  schema_version: "remediate-code-contract-pipeline/repair-state/v1alpha1";
  /**
   * One entry per judge-ordered repair step emission (keyed by judge hash).
   * `accepted_ce_ids` records the judge-accepted counterexample ids this repair
   * was dispatched to address, for human debugging/display only.
   * `addressed_ce_fingerprints` is the CONTENT-keyed form the convergence gate
   * actually diffs against — see `counterexampleKeyOf`: raw reviewer
   * ids are not stable cross-round identity (two independent adversarial
   * rounds commonly both label their top counterexample "CE-001"), so the gate
   * resolves each accepted id against the live counterexample artifact and
   * keys on content (violated_obligation_ids + normalized claim) instead,
   * falling back to raw-id keying only when an id cannot be resolved. The
   * cumulative union of fingerprints across repairs is the "already-addressed"
   * set; a re-accepted (un-converged) counterexample is detected as a stall
   * rather than silently re-repaired. Entries written before this field
   * existed lack it — they default to `[]` (fail-open: at most one extra
   * repair round on an in-flight upgrade, never a false stall).
   */
  repairs: {
    judge_hash: string;
    target: string;
    at: string;
    accepted_ce_ids?: string[];
    addressed_ce_fingerprints?: string[];
  }[];
  /**
   * One entry per conceptual-design-critique-driven design repair (keyed by
   * critique hash). `blocking_ids` records the blocking critique-item ids the
   * repair was dispatched to address — the cumulative union is the
   * "already-addressed" set the critique convergence gate diffs each fresh
   * critique against, so a re-raised (un-resolved) blocking concern is detected
   * as a stall rather than silently re-repaired forever.
   */
  critique_repairs: { critique_hash: string; at: string; blocking_ids: string[] }[];
  /** One entry per implementation_dag traceability rejection. */
  dag_regenerations: { violations: string[]; at: string }[];
  /** Recorded owner waivers — absent on ledgers written before the verb existed. */
  waivers?: CounterexampleWaiver[];
}

function repairStatePath(artifactsDir: string): string {
  return join(contractPipelineDir(artifactsDir), "repair-state.json");
}

export async function readRepairState(artifactsDir: string): Promise<ContractRepairState> {
  const state = await readOptionalJsonFile<ContractRepairState>(
    repairStatePath(artifactsDir),
  );
  return (
    state ?? {
      schema_version: "remediate-code-contract-pipeline/repair-state/v1alpha1",
      repairs: [],
      critique_repairs: [],
      dag_regenerations: [],
    }
  );
}

export async function writeRepairState(
  artifactsDir: string,
  state: ContractRepairState,
): Promise<void> {
  await mkdir(contractPipelineDir(artifactsDir), { recursive: true });
  await writeJsonFile(repairStatePath(artifactsDir), state);
}

// ── Counterexample waivers ────────────────────────────────────────────────────

const COUNTEREXAMPLE_WAIVERS_FILE = "counterexample-waivers.json";

/** The tool-named host lane: the operator's waiver decisions land here. */
export function counterexampleWaiversPath(artifactsDir: string): string {
  return join(contractPipelineDir(artifactsDir), COUNTEREXAMPLE_WAIVERS_FILE);
}

/** id → live counterexample entry, from a (possibly absent) artifact payload. */
export function counterexamplesByIdOf(
  counterexamplePayload: unknown,
): Map<string, Counterexample> {
  const byId = new Map<string, Counterexample>();
  if (!isRecord(counterexamplePayload) || !Array.isArray(counterexamplePayload.counterexamples)) {
    return byId;
  }
  for (const ce of counterexamplePayload.counterexamples as unknown[]) {
    if (isRecord(ce) && typeof ce.id === "string" && ce.id.length > 0) {
      byId.set(ce.id, ce as unknown as Counterexample);
    }
  }
  return byId;
}

/**
 * Content-keyed identity for a counterexample id: `fp:<fingerprint>` when the
 * id resolves against the live artifact, `id:<raw>` otherwise. The ONE keying
 * both the convergence gate and the waiver ledger use.
 */
export function counterexampleKeyOf(
  counterexamplesById: ReadonlyMap<string, Counterexample>,
  rawId: string,
): string {
  const ce = counterexamplesById.get(rawId);
  return ce ? `fp:${counterexampleFingerprint(ce)}` : `id:${rawId}`;
}

/** Judge-accepted counterexample ids from a raw judge-report payload. */
function acceptedIdsOfJudgePayload(judgeReportPayload: unknown): string[] {
  if (!isRecord(judgeReportPayload) || !Array.isArray(judgeReportPayload.classifications)) {
    return [];
  }
  const ids: string[] = [];
  for (const cls of judgeReportPayload.classifications as unknown[]) {
    if (
      isRecord(cls) &&
      cls.classification === "accepted" &&
      typeof cls.counterexample_id === "string" &&
      cls.counterexample_id.length > 0
    ) {
      ids.push(cls.counterexample_id);
    }
  }
  return ids;
}

/** The subset of `acceptedIds` covered by recorded waivers (fingerprint-first, raw-id fallback). */
export function waivedAcceptedIds(
  state: ContractRepairState,
  counterexamplesById: ReadonlyMap<string, Counterexample>,
  acceptedIds: readonly string[],
): Set<string> {
  const waivers = state.waivers ?? [];
  if (waivers.length === 0) return new Set();
  const keys = new Set(waivers.map((w) => w.key));
  const rawIds = new Set(waivers.map((w) => w.ce_id));
  return new Set(
    acceptedIds.filter(
      (id) => keys.has(counterexampleKeyOf(counterexamplesById, id)) || rawIds.has(id),
    ),
  );
}

/**
 * Payload-level convenience for the cross-gate callers: which of the CURRENT
 * judge report's accepted counterexample ids are waived in the ledger.
 */
export function waivedJudgeAcceptedIds(
  state: ContractRepairState,
  judgeReportPayload: unknown,
  counterexamplePayload: unknown,
): Set<string> {
  return waivedAcceptedIds(
    state,
    counterexamplesByIdOf(counterexamplePayload),
    acceptedIdsOfJudgePayload(judgeReportPayload),
  );
}

/** Outcome of one waiver-file fold attempt. */
export interface WaiverFold {
  /** Validation problems. Non-empty means NOTHING was applied and the file remains. */
  issues: string[];
  /** Newly recorded waivers (0 when the file is absent or everything was a duplicate). */
  folded: number;
}

/**
 * Fold the host-written waiver file into the ledger — all-or-nothing.
 *
 * Absent file: no-op. Any invalid entry (malformed JSON, missing/empty
 * `ce_id` / `rationale` / `waived_by`, or a `ce_id` that matches neither a
 * live counterexample nor a judge-accepted id) refuses the WHOLE file: nothing
 * is applied, the file stays in place, and the issues are returned for the
 * blocked step to name — an invalid decision record must never half-apply.
 * Valid entries are deduped by content key, appended to `state.waivers`,
 * persisted, and the file is consumed (deleted).
 */
export async function foldCounterexampleWaivers(
  artifactsDir: string,
  context: {
    counterexamplesById: ReadonlyMap<string, Counterexample>;
    judgeAcceptedIds: ReadonlySet<string>;
  },
): Promise<WaiverFold> {
  const path = counterexampleWaiversPath(artifactsDir);
  let raw: unknown;
  try {
    raw = await readOptionalJsonFile<unknown>(path);
  } catch {
    return {
      issues: [
        `${COUNTEREXAMPLE_WAIVERS_FILE} is not valid JSON. Fix or delete the file; nothing was applied.`,
      ],
      folded: 0,
    };
  }
  if (raw === undefined || raw === null) return { issues: [], folded: 0 };

  const issues: string[] = [];
  const entries: { ce_id: string; rationale: string; waived_by: string }[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.waivers)) {
    issues.push(
      `${COUNTEREXAMPLE_WAIVERS_FILE} must be an object with a "waivers" array.`,
    );
  } else {
    for (const [i, entry] of (raw.waivers as unknown[]).entries()) {
      if (!isRecord(entry)) {
        issues.push(`waivers[${i}] must be an object.`);
        continue;
      }
      const ceId = typeof entry.ce_id === "string" ? entry.ce_id.trim() : "";
      const rationale = typeof entry.rationale === "string" ? entry.rationale.trim() : "";
      const waivedBy = typeof entry.waived_by === "string" ? entry.waived_by.trim() : "";
      if (ceId.length === 0) issues.push(`waivers[${i}].ce_id must be a non-empty string.`);
      if (rationale.length === 0) {
        issues.push(
          `waivers[${i}].rationale must be a non-empty string — a waiver with no reason is not a decision record.`,
        );
      }
      if (waivedBy.length === 0) {
        issues.push(`waivers[${i}].waived_by must name who decided (attributable identity).`);
      }
      if (
        ceId.length > 0 &&
        !context.counterexamplesById.has(ceId) &&
        !context.judgeAcceptedIds.has(ceId)
      ) {
        issues.push(
          `waivers[${i}].ce_id "${ceId}" matches neither a live counterexample nor a judge-accepted id — nothing to waive by that name.`,
        );
      }
      if (ceId.length > 0 && rationale.length > 0 && waivedBy.length > 0) {
        entries.push({ ce_id: ceId, rationale, waived_by: waivedBy });
      }
    }
  }
  if (issues.length > 0) return { issues, folded: 0 };

  const state = await readRepairState(artifactsDir);
  const existing = new Set((state.waivers ?? []).map((w) => w.key));
  let folded = 0;
  for (const entry of entries) {
    const key = counterexampleKeyOf(context.counterexamplesById, entry.ce_id);
    if (existing.has(key)) continue;
    existing.add(key);
    (state.waivers ??= []).push({
      ce_id: entry.ce_id,
      key,
      rationale: entry.rationale,
      waived_by: entry.waived_by,
      waived_at: new Date().toISOString(),
    });
    folded += 1;
  }
  if (folded > 0) await writeRepairState(artifactsDir, state);
  await rm(path, { force: true });
  return { issues: [], folded };
}
