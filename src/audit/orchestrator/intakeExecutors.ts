import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isGitRepo,
  writeJsonFile,
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  readProviderConfirmationInput,
  unlinkProviderConfirmationInput,
  gatherDispatchableSources,
  resolveFreshSessionProviderName,
  resolveSessionConfig,
  ambientAuditorDescriptor,
  captureNewlyReachableBackendFriction,
  PROVIDER_CONFIRMATION_FRICTION_RUN_KEY,
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
  const failClosed = input === null ? [...(gate?.newlyReachable ?? [])] : [];
  const exclude = [
    ...new Set([
      ...(input?.exclude ?? []),
      ...failClosed.map((b) => b.service_exclusion_pattern ?? b.exclusion_pattern),
    ]),
  ];
  const confirmation = confirmProviders(
    sessionConfig,
    process.env,
    exclude,
    input ?? undefined,
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
        input?.include ?? [],
        undefined,
        input ?? undefined,
        sources,
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
  return {
    updated: { ...bundle, provider_confirmation: confirmation },
    artifacts_written: artifactsWritten,
    progress_summary: renderConfirmationSummary(input, failClosed),
  };
}

function renderConfirmationSummary(
  input: ProviderConfirmationInput | null,
  newlyReachable: readonly NewlyReachableBackend[],
): string {
  if (newlyReachable.length > 0) {
    return (
      `No operator decision covers ${newlyReachable.length} newly-reachable ` +
      `backend(s), so they were fail-closed-excluded rather than dispatched ` +
      `unconfirmed (${newlyReachable.map((b) => b.key).join(", ")}).`
    );
  }
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
