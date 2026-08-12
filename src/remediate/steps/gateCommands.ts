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
    // The TEST-tree typecheck (tsconfig.test.json) is a distinct gate from
    // `check` and is part of CI's `verify:checks` — an accept leg that omits it
    // lands type-RED test files invisible to vitest and `check` (accept/reverify
    // cluster defect 12: the 2026-08-06 run landed 4 such files, the fourth
    // CP-NODE-26 accept regression). Build-free: it typechecks tests + src
    // directly, no dist involved.
    { argv: ["npm", "run", "check:tests"], build_free: true, layer: "check" },
    // BUILD-FREE unit suite at the repo root (single package — no `npm -w`, never
    // `npm test`, which prepends a build). ONE vitest runner covers all three areas
    // (tests/shared, tests/audit, tests/remediate) per vitest.config.ts `include` —
    // the node:test split was retired in the single-vitest migration, so a separate
    // `node --import tsx/esm --test` command would both be redundant with this and
    // FAIL on the current tree (the .test.mjs files use vitest globals, not node:test).
    //
    // `--retry=2` is FLAKE-TOLERANCE, not flake-masking: the tool-owned gate is a
    // ROBUSTNESS check (did the remediation's edits break the repo?), and its red is
    // COARSE-REBLOCK-ALL (INV-RS-09) — a single transient timing flake in the target
    // suite (e.g. a rolling-dispatch "expected 1 to be 2" race under full parallel
    // load) otherwise reopens EVERY item to pending and, on a second flake, terminal-
    // blocks the whole run (CE-003 bound 2) with zero fixes landed — the exact failure
    // this scoping is closing. A genuinely-broken test still fails all retries → red →
    // reblock; only a test that PASSES on retry (i.e. was flaky, not broken) is spared.
    // Gate-scoped ON PURPOSE (never vitest.config `retry`, which would mask flakes in
    // CI / `npm test` where surfacing them is the point).
    {
      argv: ["npx", "vitest", "run", "--retry=2"],
      build_free: true,
      layer: "unit",
    },
  ];
}
