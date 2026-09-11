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
// Sibling modules imported DIRECTLY, never through ../index.js: the barrel
// re-exports this module, so importing the barrel here would close a cycle
// (index → hostHandoffCore → index) that check:depgraph refuses.
import { compareCodeUnits } from "../compareCodeUnits.js";
import { hashContent } from "../hash.js";
import { stableStringify } from "../stableStringify.js";
import { isRecord } from "../validation/basic.js";
import {
  assertSubmissionRunId,
  resolveContainedPath,
  submissionPathFor,
} from "./submissionIdentity.js";
import { join, resolve } from "node:path";

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

/** The binding facts every submitted result is checked against, in one place. */
export interface IdentityBindingParams {
  readonly runId: string;
  readonly workItemId: string;
  readonly promptSha256: string;
}

/**
 * The name of one identity component, in the order both draws check them.
 *
 * ORDER IS THE CONTRACT, and it is why this is a list rather than the single
 * conjunction the two draws used to evaluate. A submission can fail several
 * components at once — a stale worker's answer typically carries another run's
 * id AND the wrong prompt digest — and a conjunction reports all of them as one
 * undifferentiated "identity binding" refusal. The host then has to re-derive
 * which component it got wrong from a message that names none of them.
 *
 * The order is most-fundamental first: the submission's own id, then the run it
 * answers, then the item, then the ask it was bound to. The FIRST failed
 * component is the one reported, so the two draws tell a host the same thing
 * about the same submission — they previously reported it in their own orders
 * (and with their own vocabularies), so the same broken submission produced two
 * different diagnostics depending on which half of the pipeline read it.
 */
export const IDENTITY_COMPONENTS = [
  "result_id",
  "run_id",
  "work_item_id",
  "prompt_sha256",
] as const;

export type IdentityComponent = (typeof IDENTITY_COMPONENTS)[number];

/**
 * The predicate for each component, keyed by the SAME union the order is drawn
 * from — a component added to one without the other is a type error, not a
 * silently unchecked field.
 */
const IDENTITY_COMPONENT_HOLDS: Readonly<
  Record<
    IdentityComponent,
    (value: Record<string, unknown>, params: IdentityBindingParams) => boolean
  >
> = {
  result_id: (value) => typeof value.result_id === "string" && value.result_id.length > 0,
  run_id: (value, params) => value.run_id === params.runId,
  work_item_id: (value, params) => value.work_item_id === params.workItemId,
  prompt_sha256: (value, params) => value.prompt_sha256 === params.promptSha256,
};

/**
 * The first identity component this submission fails, or `null` when it is
 * fully bound. The ONE walk both draws' parse paths run, so "which component
 * broke" is answered identically on both sides of the pipeline.
 */
export function firstFailedIdentityComponent(
  value: Record<string, unknown>,
  params: IdentityBindingParams,
): IdentityComponent | null {
  for (const component of IDENTITY_COMPONENTS) {
    if (!IDENTITY_COMPONENT_HOLDS[component](value, params)) return component;
  }
  return null;
}

/**
 * What the failed component IS, in words — keyed by the same union the walk
 * returns from, so a component added to {@link IDENTITY_COMPONENTS} without a
 * description here is a type error rather than a silent empty rendering.
 *
 * Every draw renders this SAME sentence for the SAME broken submission. Before
 * it, the walk shared an ORDER but not a VOCABULARY: audit named the broken
 * component (`identity binding: run_id is not this run's '…'`), while remediate
 * emitted one of two undifferentiated sentences that named none of them — so an
 * operator repairing a rejected result learned which field to fix only when the
 * audit half happened to be the one that read it. Naming the component is the
 * whole point of classifying it.
 *
 * The value the submission carried is deliberately NOT rendered: a `run_id` or
 * `prompt_sha256` echoed back into a host-facing step is noise at best, and the
 * digest is not something a host can act on. The component NAME and what it was
 * supposed to be are what the repair needs.
 */
const IDENTITY_COMPONENT_DESCRIPTIONS: Readonly<
  Record<IdentityComponent, string>
> = {
  result_id: "result_id is not a non-empty string",
  run_id: "run_id is not the run that issued this workload",
  work_item_id: "work_item_id is not the work item this result was read for",
  prompt_sha256: "prompt_sha256 is not the digest of the prompt this work item was issued with",
};

/** The description of one identity component's failure — see the table above. */
export function describeIdentityFailure(component: IdentityComponent): string {
  return IDENTITY_COMPONENT_DESCRIPTIONS[component];
}

/**
 * The ONE diagnostic both draws render for a submission that fails the identity
 * binding, or `null` when it is fully bound. Shared so the same broken
 * submission produces the same sentence whichever half of the pipeline reads
 * it — the draw supplies only its own framing around this phrase.
 */
export function identityFailureDiagnostic(
  value: Record<string, unknown>,
  params: IdentityBindingParams,
): string | null {
  const component = firstFailedIdentityComponent(value, params);
  return component === null ? null : describeIdentityFailure(component);
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
