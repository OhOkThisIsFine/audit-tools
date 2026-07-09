import { existsSync } from "node:fs";
import { join } from "node:path";

// Pinned, deterministically-derived gate command set for the audit-tools monorepo.
// Single-sourced here so BOTH the tool-owned final gate / phase-boundary gate
// (`nextStep.ts`) and the per-node merged-base check (`dispatch.ts`) draw the exact
// command from one derivation rather than a hardcoded string literal — a literal
// `"npm run check"` default is host-discretion-by-prose (it assumes npm + a `check`
// script) and fails the everything-agnostic test. Living in its own leaf module
// keeps `dispatch.ts` free of an import cycle with `nextStep.ts` (which imports
// `dispatch.ts`).

/** One command in the tool-owned final gate. */
export interface FinalGateCommandSpec {
  argv: string[];
  /** True for commands that neither build nor run a build-prepending test script. */
  build_free: boolean;
  /** The package this command's unit suite targets (single-flight key), if any. */
  package_dir?: string;
  /** Which layer of the floor this belongs to. */
  layer: "build" | "check" | "unit";
}

/**
 * Whether `root` is the audit-tools monorepo — the repo the tool-owned final
 * gate's suite (INV-RS-10, literally the audit-tools build/check/per-package
 * commands) applies to. The gate's command list is audit-tools-specific by
 * design (this remediation run remediates the audit-tools monorepo), so it is
 * scoped to that structure rather than fabricated for an arbitrary target repo.
 */
export function isAuditToolsMonorepo(root: string): boolean {
  // Single-package layout: the three subsystems are inlined under src/ and both
  // bins live at the repo root. (Name kept for continuity; it is now one package.)
  return (
    existsSync(join(root, "src", "shared")) &&
    existsSync(join(root, "src", "audit")) &&
    existsSync(join(root, "src", "remediate")) &&
    existsSync(join(root, "audit-code.mjs")) &&
    existsSync(join(root, "remediate-code.mjs"))
  );
}

/**
 * The tool-owned final-gate command list (INV-RS-10) for the audit-tools
 * monorepo. Pure and deterministic so tests can assert: it is non-vacuous
 * (always > 0 build + check + unit commands) for the audit-tools structure,
 * never references `plan.test_command`, every UNIT command is build-free, and no
 * package's unit suite appears twice (single-flight — CE-001). Returns `[]` when
 * `root` is not the audit-tools monorepo (the audit-tools-specific suite is
 * inapplicable there — see `runToolOwnedFinalGate`).
 */
export function toolOwnedFinalGateCommands(root: string): FinalGateCommandSpec[] {
  if (!isAuditToolsMonorepo(root)) return [];
  return [
    { argv: ["npm", "run", "build"], build_free: false, layer: "build" },
    { argv: ["npm", "run", "check"], build_free: true, layer: "check" },
    // BUILD-FREE unit suites at the repo root (single package — no `npm -w`, never
    // `npm test`, which prepends a build). node:test for shared+audit, vitest for remediate.
    {
      argv: ["node", "--import", "tsx/esm", "--test", "tests/shared/*.test.mjs", "tests/audit/*.test.mjs"],
      build_free: true,
      layer: "unit",
    },
    {
      argv: ["npx", "vitest", "run"],
      build_free: true,
      layer: "unit",
    },
  ];
}

/**
 * The pinned argv for the per-node merged-base cross-package check (INV-2): the
 * `check`-layer (typecheck) command from the tool-owned gate set, derived from the
 * repo structure rather than a hardcoded string. Catches a cross-package type break
 * that a per-node worktree verify cannot (its `@audit-tools` junction resolves to an
 * unfaithful main). Returns `null` when the audit-tools suite is inapplicable
 * (non-monorepo target) — the merged-base check is then skipped, exactly as the old
 * explicit-`null` did, rather than fabricating a check command for an arbitrary repo.
 */
export function mergedBaseCheckArgv(root: string): string[] | null {
  const check = toolOwnedFinalGateCommands(root).find((c) => c.layer === "check");
  return check ? check.argv : null;
}

/**
 * The pinned argv for the per-node CROSS-CUTTING invariant/contract guard suite (the
 * `verify:guards` script = the full vitest suite MINUS the heavy subprocess-spawning
 * integration/e2e tests). Run in the MAIN checkout AFTER a node's cherry-pick lands,
 * but ONLY when that node's edits touched a loop-core path (`isLoopCorePath`) — the
 * bound that keeps the guard off the cheap path. A per-node worktree verify runs only
 * the node's OWN targeted tests + a merged-base typecheck, so a cross-file
 * invariant/contract regression (a broken guard test in another area) escapes
 * node-local verify and surfaces only late at close with a coarse, un-attributable
 * reblock; running the guard suite here attributes the break to the node that caused
 * it and rolls it back. Returns `null` when the audit-tools suite is inapplicable
 * (non-monorepo target) — same scoped-out contract as `mergedBaseCheckArgv` — since
 * the guard suite is the audit-tools-specific `verify:guards` script (this remediation
 * run remediates the audit-tools monorepo itself), never fabricated for an arbitrary
 * target repo.
 */
export function mergedGuardSuiteArgv(root: string): string[] | null {
  return isAuditToolsMonorepo(root) ? ["npm", "run", "verify:guards"] : null;
}
