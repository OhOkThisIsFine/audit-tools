/**
 * The ONE host-handoff boundary both orchestrators draw from.
 *
 * The audit host handoff (`src/audit/cli/dispatch/hostHandoff.ts`) and the
 * remediation one (`src/remediate/steps/dispatch/hostHandoff.ts`) were two
 * independently evolved bodies that had already converged on the same skeleton:
 * resolve a run-scoped boundary, derive each work item's bound result path
 * through the shared submission-path rule, hash the prompt, validate the
 * workload against its bindings, and refuse a result whose identity, prompt
 * binding, or result-map entry does not match the derivation. Every place they
 * differed in TEXT but not in MEANING is what this core owns now; what remains
 * in each twin is its DRAW — the contract versions and shapes it persists, the
 * domain validation it applies on top, the state it mutates.
 */
import {
  assertSubmissionRunId,
  hashContent,
  resolveContainedPath,
  stableStringify,
  submissionPathFor,
} from "../index.js";
import { join, resolve } from "node:path";

/** Code-unit lexical order — the shared comparator for every id sort here. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact key set, order-insensitive: a persisted envelope admits no extra keys. */
export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareCodeUnits);
  return (
    actual.length === expected.length &&
    actual.every(
      (key, index) => key === [...expected].sort(compareCodeUnits)[index],
    )
  );
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/** Full sha1/sha256 commit id — the only form a baseline may take. */
export function isCommit(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
  );
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

/** Element-wise equality of two string arrays (order-significant). */
export function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

/**
 * The dedupe key for an accepted binding: work item × prompt digest, joined by
 * NUL (`String.fromCharCode(0)` in source — never the raw control byte in this
 * file, which git would treat as binary).
 */
const BINDING_IDENTITY_SEPARATOR = String.fromCharCode(0);

/** The dedupe key for an accepted binding: work item × prompt digest. */
export function bindingIdentity(entry: {
  readonly work_item_id: string;
  readonly prompt_sha256: string;
}): string {
  return `${entry.work_item_id}${BINDING_IDENTITY_SEPARATOR}${entry.prompt_sha256}`;
}

/**
 * The run-scoped paths one host-handoff boundary lives at.
 *
 * Both twins resolved these with the same three calls (`assertSubmissionRunId`,
 * containment on the artifacts dir, containment on `runs/<runId>`), differing
 * only in whether the run directory carried a sub-segment. The sub-segment is a
 * parameter here, not a fork: remediate's run dir sits under `runs/<id>/implement`
 * because its runs dir also holds triage/closing lanes; audit's sits directly
 * under `runs/<id>`.
 */
export interface HostHandoffPaths {
  /** Absolute repository root everything is contained beneath. */
  readonly root: string;
  /** Absolute artifacts dir (`.audit-tools/<tool>/`). */
  readonly artifactsDir: string;
  /** Absolute run directory the workload and results live under. */
  readonly runDir: string;
  /** Absolute directory submissions land in. */
  readonly resultDir: string;
  /** Absolute path of the persisted workload document. */
  readonly workloadPath: string;
}

/**
 * Resolve the run-scoped boundary paths. Throws when the run id leaves the
 * shared grammar or either declared root escapes containment — before any
 * caller has a path to write to.
 */
export function resolveHostHandoffPaths(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  /**
   * Segments between the RUN DIRECTORY and its lane sub-directory — i.e. AFTER
   * the run id: `runs/<runId>/<segments…>`. Empty for audit's flat
   * `runs/<runId>/`; `["implement"]` for remediate's lane-scoped one. Order is
   * load-bearing: validators join submissions to their run by the FIRST path
   * segment under `runs/`, so the run id must stay that segment.
   */
  readonly runDirSegments?: readonly string[];
  /** Names this draw in the run-id refusal (`Invalid <label>: …`). */
  readonly runIdLabel?: string;
}): HostHandoffPaths {
  assertSubmissionRunId(
    params.runId,
    params.runIdLabel ?? "host handoff run id",
  );
  const root = resolve(params.root);
  const artifactsDir = resolveContainedPath(root, params.artifactsDir, "artifactsDir");
  const segments = params.runDirSegments ?? [];
  const runDir = resolveContainedPath(
    artifactsDir,
    join("runs", params.runId, ...segments),
    "host handoff run directory",
  );
  return {
    root,
    artifactsDir,
    runDir,
    resultDir: join(runDir, "host-results"),
    workloadPath: join(runDir, "host-workload.json"),
  };
}

/**
 * The bound path for one work item's submission — the SHARED rule, not a local
 * copy of it. `<resultDir>/<sha256(id)>.json`, repository-relative and
 * forward-slashed. This replaces the byte-equivalent private `resultPathFor`
 * copies both twins carried; a divergence between them would have been silent
 * on both sides.
 */
export function hostHandoffResultPath(
  paths: HostHandoffPaths,
  id: string,
): string {
  return submissionPathFor(
    { root: paths.root, submissionDir: paths.resultDir },
    id,
  );
}

/** Absolute form of {@link hostHandoffResultPath}, for readers on disk. */
export function absoluteHostHandoffResultPath(
  paths: HostHandoffPaths,
  id: string,
): string {
  return resolveContainedPath(
    paths.root,
    hostHandoffResultPath(paths, id),
    `result path for ${id}`,
  );
}

/** Content digest of one prompt text — the binding between ask and answer. */
export function promptSha256(promptText: string): string {
  return hashContent(promptText);
}

/** Content digest of one canonical JSON rendering. */
export function contentSha256(value: unknown): string {
  return hashContent(stableStringify(value));
}

// ── Envelope, item, and binding validation ──────────────────────────────────
//
// Both draws parse the SAME document family out of the run directory — a
// workload envelope carrying `work_items`, per-item trusted bindings keyed by
// work item, and a result map naming where each answer lands — and both used to
// re-derive the scaffolding by hand. The shapes below are the shared skeleton;
// a draw adds only its own contract version, its own item parser, and whatever
// domain fields its bindings carry.

/** The `{ contract_version, run_id, work_items }` envelope both workloads use. */
const WORKLOAD_ENVELOPE_KEYS = ["contract_version", "run_id", "work_items"] as const;

export type WorkloadEnvelopeParse =
  | { readonly ok: true; readonly rawItems: readonly unknown[] }
  | { readonly ok: false };

/**
 * Validate a persisted workload ENVELOPE against this run: exact keys, the
 * draw's contract version, the run id, and an array of raw items. Item-level
 * shape is the draw's parser ({@link parseAllWorkloadItems}); anything the
 * persisted trusted binding further pins (a digest, a baseline) is the draw's
 * policy layered on top of the `ok` case.
 */
export function parseWorkloadEnvelope(
  value: unknown,
  params: {
    readonly contractVersion: string;
    readonly runId: string;
  },
): WorkloadEnvelopeParse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, WORKLOAD_ENVELOPE_KEYS) ||
    value.contract_version !== params.contractVersion ||
    value.run_id !== params.runId ||
    !Array.isArray(value.work_items)
  ) {
    return { ok: false };
  }
  return { ok: true, rawItems: value.work_items };
}

/** Map raw items through the draw's parser; `null` when ANY item refuses. */
export function parseAllWorkloadItems<T>(
  rawItems: readonly unknown[],
  parseItem: (raw: unknown) => T | null,
): readonly T[] | null {
  const items: T[] = [];
  for (const raw of rawItems) {
    const item = parseItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

/** Every id distinct — the duplicate-work-item refusal. */
export function idsAreUnique(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

/**
 * Strictly ascending in code-unit order — which is BOTH "sorted" and
 * "duplicate-free", the two properties every persisted workload's id list must
 * have for a re-derivation to compare equal byte-for-byte.
 */
export function idsAreStrictlyAscending(ids: readonly string[]): boolean {
  return !ids.some(
    (id, index) =>
      index > 0 && compareCodeUnits(ids[index - 1]!, id) >= 0,
  );
}

/**
 * The identity binding EVERY submitted result carries, identical on both
 * draws: a non-empty `result_id`, this run's id, this work item's id, and the
 * prompt digest of the ask. A refusal here is a REFUSAL, never a repair — the
 * tool cannot know which of the three the host meant.
 */
export function resultIdentityIsBound(
  value: Record<string, unknown>,
  params: {
    readonly runId: string;
    readonly workItemId: string;
    readonly promptSha256: string;
  },
): boolean {
  return (
    typeof value.result_id === "string" &&
    value.result_id.length > 0 &&
    value.run_id === params.runId &&
    value.work_item_id === params.workItemId &&
    value.prompt_sha256 === params.promptSha256
  );
}

/** The minimal view of a parsed work item the result-map check needs. */
export interface ResultMappedItem {
  readonly id: string;
  readonly prompt: { readonly sha256: string };
  readonly result_path: string;
}

/** One `host-result-map.json` entry, as both draws persist it. */
export interface ResultMapEntry {
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly result_path: string;
}

/**
 * RESULT-MAP IDENTITY: the map names exactly the workload's items, once each,
 * with each item's own prompt digest and derived bound path. This was the
 * second half of the audit twin's `validateHandoffBinding`, hand-inlined there;
 * the remediate draw pins the same facts through its whole-document digest
 * instead — but the CHECK itself is the draw-independent statement of "the map
 * and the workload agree", so it lives here for whichever draw parses a map.
 *
 * The failure is CLASSIFIED, not collapsed: `coverage` means the map does not
 * name this workload's items exactly once each; `identity` means an entry
 * names the right item but pins another item's prompt digest or a bound path
 * the shared rule does not derive. The two are not interchangeable to the
 * caller — one says the MAP is wrong, the other names the BINDING that broke.
 */
export type ResultMapIdentity<TItem extends ResultMappedItem> =
  | { readonly ok: true; readonly byId: ReadonlyMap<string, TItem> }
  | {
      readonly ok: false;
      readonly reason: "coverage" | "identity";
      readonly workItemId?: string;
    };

export function resultMapIdentity<TItem extends ResultMappedItem>(
  items: readonly TItem[],
  entries: readonly ResultMapEntry[],
): ResultMapIdentity<TItem> {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (entries.length !== byId.size) return { ok: false, reason: "coverage" };
  const seen = new Set<string>();
  for (const entry of entries) {
    const item = byId.get(entry.work_item_id);
    if (item === undefined || seen.has(entry.work_item_id)) {
      return { ok: false, reason: "coverage" };
    }
    if (
      entry.prompt_sha256 !== item.prompt.sha256 ||
      entry.result_path !== item.result_path
    ) {
      return {
        ok: false,
        reason: "identity",
        workItemId: entry.work_item_id,
      };
    }
    seen.add(entry.work_item_id);
  }
  return { ok: true, byId };
}

/**
 * First duplicate identity in `entries`, or null. The accepted-results ledger
 * and any other keyed record derives its dedupe refusal from this rather than
 * from a hand-rolled Set walk whose message and predicate can drift apart.
 */
export function firstDuplicateIdentity<T>(
  entries: readonly T[],
  identity: (entry: T) => string,
): T | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = identity(entry);
    if (seen.has(key)) return entry;
    seen.add(key);
  }
  return null;
}
