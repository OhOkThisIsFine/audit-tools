import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isGitRepo,
  writeJsonFile,
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  readSharedProviderConfirmation,
  readProviderConfirmationInput,
  carryForwardConfirmationInput,
  retainAutoExclusions,
  detectDiscardedCapabilityReorder,
  unlinkProviderConfirmationInput,
  gatherDispatchableSources,
  resolveFreshSessionProviderName,
  resolveSessionConfig,
  captureNewlyReachableBackendFriction,
  PROVIDER_CONFIRMATION_FRICTION_RUN_KEY,
  captureUnrankedCapabilityPromotionFriction,
  type SessionConfig,
  type NewlyReachableBackend,
  type ProviderConfirmationInput,
} from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { confirmProviders } from "./providerConfirmation.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import {
  buildFileDisposition,
  isAuditExcludedStatus,
} from "../extractors/disposition.js";
import { buildRepoManifestFromFs } from "../extractors/fsIntake.js";
import { loadIgnoreFile } from "../extractors/ignore.js";
import type { ExecutorRunResult, ScopeSummary } from "./executorResult.js";
import type { ProviderConfirmationGateState } from "./advanceTypes.js";

interface PackageJsonShape {
  name?: unknown;
  workspaces?: unknown;
}

/**
 * Synthetic run key for Gate-0 friction. The confirmation gate runs BEFORE any run
 * id exists, and the capture chokepoint keys de-dup on {eventType, runId,
 * discriminator} — a stable constant here means the real discriminator (the backend
 * key) does the distinguishing, so a re-derive never double-logs the same backend.
 */

/**
 * Detect signals that the resolved audit root may be the *wrong* directory.
 * Two heuristics, returned as zero or more human-readable warnings:
 *
 *  a. No-git-but-ancestor-is-repo — `root` is not a git repo but some ancestor
 *     directory is (you probably targeted a subdirectory instead of the repo
 *     root).
 *  b. Workspace-member — `root` has a `package.json` with a `name`, and its
 *     parent has a `package.json` declaring `workspaces` (you probably want to
 *     audit from the monorepo root).
 *
 * Returns an empty array when the scope looks correct. Never throws.
 */
export function detectMisScopeSmells(root: string): string[] {
  const smells: string[] = [];

  // (a) No .git here, but an ancestor is a git repository.
  if (!isGitRepo(root)) {
    let current = dirname(root);
    let previous = root;
    while (current && current !== previous) {
      if (existsSync(join(current, ".git"))) {
        smells.push(
          `root has no .git but ancestor '${current}' is a git repository — you may have targeted a subdirectory instead of the repo root`,
        );
        break;
      }
      previous = current;
      current = dirname(current);
    }
  }

  // (b) Workspace member of a parent monorepo.
  // Walk up ancestor directories (up to 3 levels) looking for a package.json
  // that declares a `workspaces` field. This handles standard nested monorepo
  // layouts like `monorepo-root/packages/my-pkg` where the direct parent
  // (`packages/`) has no package.json of its own. Stop early if a .git
  // boundary is found (we already checked that case under heuristic (a)).
  const rootPkg = readPackageJson(root);
  if (rootPkg && rootPkg.name !== undefined) {
    let current = dirname(root);
    let previous = root;
    let levelsChecked = 0;
    const maxLevels = 3;
    while (current && current !== previous && levelsChecked < maxLevels) {
      const ancestorPkg = readPackageJson(current);
      if (ancestorPkg && ancestorPkg.workspaces !== undefined) {
        smells.push(
          `root appears to be a workspace member of a parent monorepo at '${current}' — consider auditing from the monorepo root instead`,
        );
        break;
      }
      // Stop at a .git boundary — the repo root won't be a workspaces ancestor.
      if (existsSync(join(current, ".git"))) {
        break;
      }
      previous = current;
      current = dirname(current);
      levelsChecked++;
    }
  }

  return smells;
}

function readPackageJson(dir: string): PackageJsonShape | undefined {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as PackageJsonShape)
      : undefined;
  } catch {
    // Missing or malformed package.json — treat as absent for smell purposes.
    return undefined;
  }
}

/**
 * Headless deterministic fallback for the provider confirmation gate — mirrors
 * the `runIntentCheckpointAutoComplete` pattern. The conversation-first flow
 * emits a `provider_confirmation` host step; this runs only when `advanceAudit`
 * is driven headlessly with no host to confirm the provider pool, writing a
 * default provider_confirmation artifact so the pipeline can proceed.
 *
 * DC-2: audit is the single WRITER of the shared session-level confirmation at
 * `<root>/.audit-tools/provider-confirmation.json`. When `root` is known we also
 * write that shared artifact (atomic temp-then-rename under a file lock — CE-003)
 * so a subsequent remediate run can read + honor the same pool. The per-tool
 * `provider_confirmation` bundle field (the N-X06 seam contract) is unchanged;
 * the shared artifact carries the operator's reach-free route DECISION.
 *
 * G3 — the write half of the reconciliation gate. **This executor never silently
 * honors a newly-reachable backend.** If it is asked to promote while the gate
 * carries a delta and there is NO operator submission, it fails CLOSED (persists an
 * exclusion) and records a `newly_reachable_backend` friction event.
 *
 * That rule is deliberately NOT keyed on `autonomous`, and the asymmetry matters:
 * `autonomous` decides who gets ASKED — the CLI emits the delta prompt on an attended
 * run and folds straight to this executor on an unattended one — but it can never
 * make silently including an unconfirmed backend correct. This function is exported
 * and reachable from `advanceAudit` directly, so the no-silent-honor property is
 * enforced HERE rather than resting on a caller's branch being right (a caller that
 * promotes an attended delta without asking IS the bug the gate exists to catch).
 * Enforce in the tool, never in a caller remembering.
 *
 * A first-ever confirmation is unaffected: with no confirmation on disk there is no
 * decision to reconcile against, so the delta is empty and nothing fails closed.
 *
 * The persist is MANDATORY, not incidental: `provider_confirmation` is `PRIORITY[0]`,
 * so a delta that never clears is a drain LIVELOCK, not a no-op. On a successful
 * promotion the gate is CLEARED — the rebuild folds every reachable backend into
 * `provider_pool` (an excluded entry stays IN the pool), so all of REACH-NOW is now
 * CONFIRMED and the delta is empty by construction.
 */
export async function runProviderConfirmationAutoComplete(
  bundle: ArtifactBundle,
  root?: string,
  artifactsDir?: string,
  effectiveConfig?: SessionConfig,
  gate?: ProviderConfirmationGateState,
): Promise<ExecutorRunResult> {
  // G2: prefer the EFFECTIVE dispatch config threaded from the next-step drain (the
  // per-auditor descriptor resolved over the repo INTENT). The confirmed pool this
  // executor builds + persists is what routes for the whole session, so it MUST reflect
  // the current auditor's descriptor, not a re-read of the repo config
  // (spec/unified-dispatch-worker-model.md). Fall back to the repo INTENT resolved against
  // the AMBIENT descriptor when no effective config was threaded — e.g. the legacy headless
  // advance-audit entrypoint, which carries no handshake but still HAS an environment, so
  // its reachable lanes must appear in the confirmed roster (what the operator confirms is
  // what routes). A `null` descriptor here would hide a declared+reachable backend from
  // Gate-0 entirely. Degrade to the empty permissive default when the config is
  // absent/unreadable — pricing is best-effort and must never block confirmation.
  const sessionConfig: SessionConfig =
    effectiveConfig ??
    (artifactsDir
      ? resolveSessionConfig(
          await loadSessionConfig(artifactsDir).catch(() => ({})),
          ambientAuditorDescriptor(),
        )
      : {});
  // Interactive Gate-0: the host may have submitted an operator ordering + host
  // roster to `provider-confirmation.input.json` (spec/cost-first-routing.md).
  // Absent ⇒ the tool's price-ascending suggestion (headless / no-operator path).
  const input = artifactsDir
    ? await readProviderConfirmationInput(artifactsDir)
    : null;
  // The confirmation as it stands BEFORE this promotion — read once, used for the
  // carry-forward merge below. Absent on a first-time confirmation.
  const priorConfirmation = root ? await readSharedProviderConfirmation(root) : null;
  /** Models the capability gate flagged that this promotion clears WITHOUT ranking. */
  let unrankedOnPromotion: string[] = [];
  /**
   * Anchor ids whose reorder this promotion is about to DISCARD. Computed before the
   * merge, from the RAW submission — `effectiveInput` already carries the merged (i.e.
   * reorder-free) order, so asking it afterwards can never reveal what was dropped.
   *
   * Reported rather than honored: repositioning an already-ranked model without
   * restating the whole roster needs the anchor-provenance split in `docs/backlog.md`.
   * What is NOT acceptable is doing it silently — an accepted-then-discarded operator
   * decision is the same "the operator had to notice" failure the reach delta and the
   * capability fail-open are both reported for.
   */
  const discardedReorder = detectDiscardedCapabilityReorder(
    priorConfirmation?.policy?.capability_order ?? [],
    input?.capability_order ?? [],
  );
  // G3 fail-closed reconciliation: a backend the operator never confirmed must not
  // become dispatchable merely because it is reachable. Excluding it is the
  // conservative direction — the run proceeds on the confirmed backends.
  //
  // Keyed on `input === null` ALONE, not on `autonomous`: a submission IS the
  // operator's decision and supersedes (on the attended path the gate prompts the
  // delta and this promotes their answer), but with NO submission there is no
  // decision to honor and including the backend would be the silent dispatch the gate
  // exists to prevent — attended or not. See the header for why this is enforced here
  // rather than in the caller's branch.
  //
  // A″: each backend carries the `DispatchExclusionPattern` that rules out EXACTLY
  // it — `provider:model` where the model is knowable, else the coarse `provider`
  // tier for a CLI whose model only arrives at the dispatch handshake. So excluding
  // one new model of a multi-model backend no longer drops that backend's other
  // sources. The pattern is built by the gate beside the key it compared, never
  // re-derived here, so the rule persisted cannot drift from the delta detected.
  // Stage 5: the autonomous fail-closed write emits the `service:` axis, because that
  // is the axis that does not decay and closes multi-transport residue durably.
  // R3-3: Headless promotion via capability ranker. When running headlessly (input === null),
  // if there are unevidenced capability models, auto-rank them so that every dispatchable
  // model receives a capability_rank and headless runs do not wedge on PRIORITY[0].
  const unevidenced = gate?.unevidencedCapability ?? [];
  let autoInput: ProviderConfirmationInput | null = input;
  if (input === null && unevidenced.length > 0) {
    const priorOrder = priorConfirmation?.policy?.capability_order ?? [];
    const autoOrder = rankHeadlessCapabilityPools(unevidenced, priorOrder);
    autoInput = {
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      capability_order: autoOrder,
    };
  }

  const effectiveInput = carryForwardConfirmationInput(autoInput, priorConfirmation);
  const failClosed = input === null ? [...(gate?.newlyReachable ?? [])] : [];
  // Read the CARRIED input, not the raw submission: the operator's prior exclusions are
  // a durable rule, and rebuilding this list from `input.exclude` alone is what let a
  // capability-only submission silently lift them — a fail-OPEN, the worst direction.
  //
  // Kept SEPARATE from the gate's own fail-closed patterns below. Merging them was the
  // mirror-image bug: the carry-forward could not tell the two apart, so a tool guess
  // became permanent operator policy and the operator's next submission no longer
  // superseded it (with no signal — by then the backend is a confirmed key, so the
  // reconciliation delta never re-surfaces it either).
  const exclude = [...new Set(effectiveInput?.exclude ?? [])];
  // Gate-authored. The NEW fail-closed patterns from this promotion, UNIONED with the
  // prior ones that this submission did not address ({@link retainAutoExclusions}).
  //
  // Rebuilding from `failClosed` alone was a fail-OPEN: an excluded entry still counts
  // as a confirmed key, so the reach delta goes empty after the first promotion and the
  // next one dropped the exclusion entirely — re-admitting a backend the operator never
  // confirmed. Carrying is therefore mandatory; what a submission supersedes is only the
  // patterns it actually speaks to.
  const autoExclude = [
    ...new Set([
      ...retainAutoExclusions(priorConfirmation?.policy?.auto_exclude ?? [], input),
      ...failClosed.map((b) => b.service_exclusion_pattern ?? b.exclusion_pattern),
    ]),
  ];
  const confirmation = confirmProviders(
    sessionConfig,
    process.env,
    // The per-tool seam carries no policy provenance — it is a pool SNAPSHOT, so what
    // matters here is only which entries are excluded. Union, deliberately.
    [...exclude, ...autoExclude],
    effectiveInput ?? undefined,
  );
  const artifactsWritten = ["provider_confirmation.json"];
  if (root) {
    // Gate-0 source fold: expand every dispatchable source pool (the explicit
    // `sources[]`) so the confirmed cost ordering the operator approves is exactly
    // what routes.
    const primaryProviderName = resolveFreshSessionProviderName(undefined, sessionConfig, {
      env: process.env,
    });
    const sources = await gatherDispatchableSources(sessionConfig, primaryProviderName);
    await writeSharedProviderConfirmation(
      root,
      buildSharedProviderConfirmation(
        sessionConfig,
        process.env,
        exclude,
        // `effectiveInput`, never the raw submission — the sixth face of the same
        // defect class, and the last one: reading `input.include` here destroys a
        // prior `policy.include` on any submission that does not restate it. Unlike
        // the `exclude` case this fails CLOSED (a self-spawn-blocked provider the
        // operator deliberately opted back in silently drops out of the pool again),
        // so it is not a routing-safety hole — but it is still an operator decision
        // deleted without a signal.
        effectiveInput?.include ?? [],
        undefined,
        effectiveInput ?? undefined,
        sources,
        autoExclude,
      ),
    );
    artifactsWritten.push("provider-confirmation.json");
    // G3: the shared confirmation — the ONLY artifact dispatch reads, and the gate's
    // CONFIRMED operand — now folds every reachable backend into `provider_pool`. So
    // the delta is empty by construction and the gate must say so: leaving it set
    // re-selects this `PRIORITY[0]` obligation on the very next fold (autonomous →
    // re-promote until `advance` throws; attended → re-prompt a delta that is now a
    // lie). Cleared HERE, inside `if (root)`, because that is exactly where CONFIRMED
    // actually changed.
    if (gate) gate.newlyReachable = [];
    // Same clearing rule, same reason: the promotion just wrote `capability_rank` for
    // everything the operator/LLM ordered, so the capability delta is empty by
    // construction and a stale non-empty value re-selects this `PRIORITY[0]`
    // obligation forever. Cleared HERE because this is where the ranks actually
    // changed. (Any model still genuinely unranked is re-detected next invocation by
    // `resolveUnevidencedCapabilityPools` — the delta is recomputed, never inherited.)
    //
    // What the submission did NOT rank is captured first: on the autonomous path there
    // is no input file at all and this executor is deterministic, so the delta clears
    // with nothing recorded. That promotion is legitimate (refusing would livelock,
    // and fail-closed-excluding an unranked pool would silently shrink the dispatch
    // set) but it must not be SILENT — it is reported in the progress summary.
    unrankedOnPromotion = (gate?.unevidencedCapability ?? []).filter(
      (model) => !(effectiveInput?.capability_order ?? []).includes(model),
    );
    if (gate) gate.unevidencedCapability = [];
  }
  // G3 consume-and-INVALIDATE. The input has now been promoted, so it is spent — and
  // leaving it on disk is what would make the gate never fire at all: a LATER delta
  // re-opens this obligation, the CLI finds the old submission still sitting there,
  // routes to this executor instead of emitting the prompt, and folds the
  // newly-reachable backend into the confirmed pool with `excluded: false` — silently
  // dispatching a backend the operator never confirmed, the exact negation of the
  // gate. Unlinking makes a stale submission unable to answer a question it was never
  // asked.
  //
  // Guarded on `root`: without it the shared artifact — the only one dispatch reads —
  // was never written, so the submission has NOT been promoted anywhere durable.
  // Deleting it would destroy the operator's decision unrecoverably.
  if (input && artifactsDir && root) {
    await unlinkProviderConfirmationInput(artifactsDir);
  }
  if (failClosed.length > 0 && artifactsDir) {
    // Loud, not silent: the operator learns (out of band) that autonomy ruled a
    // backend out on their behalf, and can re-include it at the next attended gate.
    // Gate-0 predates any run id, so the facts are discriminated by backend key under
    // a stable synthetic run key — enough for the de-dup this capture needs.
    await captureNewlyReachableBackendFriction(
      artifactsDir,
      PROVIDER_CONFIRMATION_FRICTION_RUN_KEY,
      failClosed.map((b) => b.key),
      "audit-code",
    );
  }
  if (unrankedOnPromotion.length > 0 && artifactsDir) {
    // Parity with the reach delta above, and for the same reason: the progress summary
    // states this, but a drain can fold that summary away — the friction record is what
    // survives to the close-out walk. Same synthetic run key: Gate-0 predates any run id.
    await captureUnrankedCapabilityPromotionFriction(
      artifactsDir,
      PROVIDER_CONFIRMATION_FRICTION_RUN_KEY,
      unrankedOnPromotion,
      "audit-code",
    );
  }
  return {
    updated: { ...bundle, provider_confirmation: confirmation },
    artifacts_written: artifactsWritten,
    progress_summary: renderConfirmationSummary(
      input,
      failClosed,
      unrankedOnPromotion,
      discardedReorder,
    ),
  };
}

function renderConfirmationSummary(
  input: ProviderConfirmationInput | null,
  newlyReachable: readonly NewlyReachableBackend[],
  unrankedOnPromotion: readonly string[] = [],
  discardedReorder: readonly string[] = [],
): string {
  // ACCUMULATE, never early-return. These outcomes CO-OCCUR: a submission can reorder
  // anchors (discarded) while the same promotion clears a capability delta it did not
  // rank (`unrankedOnPromotion`). An if/return chain reported only the first, so the
  // second cleared SILENTLY — the very thing each of these lines exists to prevent.
  // Ordering within the list is significance, not exclusivity.
  const parts: string[] = [];
  // First: the operator submitted a decision and this promotion did not apply it.
  // Every other line reports what the tool DID; this reports what it DECLINED to do,
  // which the operator would otherwise have to notice by diffing the artifact.
  if (discardedReorder.length > 0) {
    const message =
      `Your capability_order REORDERED already-ranked model(s) ` +
      `(${discardedReorder.join(", ")}), and that reorder was NOT applied — ` +
      `previously-ranked models keep their confirmed positions, and only NEW models ` +
      `are placed by this answer. To change the relative order of models you already ` +
      `ranked, restate the FULL ordering (every previously-ranked model) in one ` +
      `capability_order. Any new models in this submission were still placed.`;
    // Also to stderr: a progress summary can be folded away by a drain, and a
    // discarded operator decision must not vanish with it.
    process.stderr.write(`WARNING: ${message}\n`);
    parts.push(message);
  }
  // Say the true thing when the capability delta is cleared with nothing recorded.
  // The autonomous path folds here with NO input file, and this executor is purely
  // deterministic — there is no LLM on it to synthesize an ordering. Clearing the
  // delta silently would be the "silently routed around" the obligation exists to
  // prevent, so the no-evidence promotion is stated rather than implied.
  if (unrankedOnPromotion.length > 0) {
    parts.push(
      `Promoted the provider confirmation with NO capability evidence for ` +
        `${unrankedOnPromotion.length} model(s) (${unrankedOnPromotion.join(", ")}) — ` +
        `they stay unranked and will fail OPEN at the admission capability floor. ` +
        `Supply a ranker, or answer capability_order on an attended run.`,
    );
  }
  if (newlyReachable.length > 0) {
    parts.push(
      `No operator decision covers ${newlyReachable.length} newly-reachable ` +
        `backend(s), so they were fail-closed-excluded rather than dispatched ` +
        `unconfirmed (${newlyReachable.map((b) => b.key).join(", ")}).`,
    );
  }
  if (parts.length > 0) return parts.join(" ");
  return input
    ? "Applied operator provider confirmation (cost ordering + host roster)."
    : "Auto-completed provider confirmation gate (headless).";
}

export async function runIntakeExecutor(
  bundle: ArtifactBundle,
  root: string,
  artifactsDir?: string,
): Promise<ExecutorRunResult> {
  const ignore = await loadIgnoreFile(root);
  const repoManifest = await buildRepoManifestFromFs({
    root,
    ignore,
    hash_files: true,
  });
  const disposition = buildFileDisposition(repoManifest, { root });
  const auditableCount = disposition.files.filter(
    (file) => !isAuditExcludedStatus(file.status),
  ).length;

  if (auditableCount === 0) {
    throw new Error(
      `No auditable files found in ${root}. The repository may be empty, generated-only, documentation-only, or filtered by .auditorignore.`,
    );
  }

  const scopeSummary: ScopeSummary = {
    repo_root: root,
    auditable_file_count: auditableCount,
    git_available: isGitRepo(root),
    mis_scope_smells: detectMisScopeSmells(root),
  };

  const artifactsWritten = ["repo_manifest.json", "file_disposition.json"];

  // Persist the scope summary alongside the other intake artifacts when we know
  // where the artifacts directory is. Hosts read scope_summary.json directly;
  // the typed `scope_summary` field on ExecutorRunResult is the in-process channel.
  if (artifactsDir) {
    await writeJsonFile(join(artifactsDir, "scope_summary.json"), scopeSummary);
    artifactsWritten.push("scope_summary.json");
  }

  const progressSummary =
    `Created intake artifacts for ${repoManifest.files.length} files ` +
    `(${auditableCount} auditable). Scope: ${root}, git: ${scopeSummary.git_available ? "yes" : "no"}` +
    (scopeSummary.mis_scope_smells.length > 0
      ? `; ${scopeSummary.mis_scope_smells.length} mis-scope warning(s)`
      : "") +
    ".";

  return {
    updated: {
      ...bundle,
      repo_manifest: repoManifest,
      file_disposition: disposition,
    },
    artifacts_written: artifactsWritten,
    progress_summary: progressSummary,
    scope_summary: scopeSummary,
  };
}
