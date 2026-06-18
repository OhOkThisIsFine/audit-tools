/**
 * Architecture disposition tests — audit-infra module
 *
 * Covers three architecture findings from the self-audit:
 *   FND-ARC-dd468422  — ArtifactBundle flat bag / no phase grouping
 *   FND-ARC-843ce274-2 — test runner split (node:test vs vitest)
 *   FND-ARC-df11fab8  — dominant unit (packages-audit-code file count)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dir, "..", "..");
// Single-package repo: pkgRoot IS the repo root.
const repoRoot = pkgRoot;

// ---------------------------------------------------------------------------
// FND-ARC-dd468422: ArtifactBundle is phase-grouped, not a flat bag
// (Primary regression assertion lives in io-remediation.test.mjs; this file
//  adds a structural source-level check.)
// ---------------------------------------------------------------------------

test("io/artifacts.ts ArtifactPayloadMap carries phase-block comments (ARC-dd468422)", async () => {
  const src = await readFile(join(pkgRoot, "src/audit/io/artifacts.ts"), "utf8");

  // Each of the 5 phases must appear as a section header comment inside
  // ArtifactPayloadMap so the grouping is visible to human readers.
  const requiredComments = [
    "Phase 0",
    "Phase 1",
    "Phase 2",
    "Phase 3",
    "Phase 4",
  ];
  for (const comment of requiredComments) {
    assert.ok(
      src.includes(comment),
      `ArtifactPayloadMap must include a '${comment}' section comment — regression guard for ARC-dd468422`,
    );
  }

  // ArtifactDefinition must carry a phase field (typed ArtifactPhase).
  assert.ok(
    src.includes("phase: ArtifactPhase"),
    "ArtifactDefinition must have a 'phase: ArtifactPhase' field",
  );

  // ArtifactBundle must be derived from ArtifactPayloadMap (Partial<…>), not a
  // hand-rolled list of 30+ independent optional fields.
  assert.ok(
    src.includes("Partial<ArtifactPayloadMap>"),
    "ArtifactBundle must be typed as Partial<ArtifactPayloadMap>",
  );
});

// ---------------------------------------------------------------------------
// FND-ARC-843ce274-2: test runner split is intentional and stable
//
// Disposition: verified-already-satisfied.
//
// audit-code uses node:test (native, zero-config, subtests via await t.test,
// suitable for a deterministic orchestrator with straightforward assertions).
// remediate-code uses vitest (watch mode, snapshot, parallel isolation — better
// fit for a stateful phase-machine with many async integration tests).
// shared uses node:test (same rationale as audit-code; no watch needed).
//
// The split is intentional, documented in CLAUDE.md, and the two frameworks
// are not interchangeable without significant test refactoring. Neither package
// is impaired by the split — each uses the framework appropriate for its needs.
// The finding predates recent work; it's accepted as a stable architectural
// decision with no actionable remediation.
//
// Regression assertion: each package's test script uses the expected framework
// so a future refactor can't silently swap frameworks without this test
// catching the change.
// ---------------------------------------------------------------------------

test("each package's test framework matches the documented intentional split (ARC-843ce274-2)", async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};

  // After the monorepo→single-package collapse the two runners stay separated
  // WITHIN one package: shared + audit dirs run under node:test (test:node),
  // remediate runs under vitest (test:remediate).
  const nodeScript = scripts["test:node"] ?? "";
  const remediateScript = scripts["test:remediate"] ?? "";

  // shared + audit: node --test over tests/shared + tests/audit
  assert.ok(
    nodeScript.includes("node") && nodeScript.includes("--test"),
    `test:node must use node --test; got: ${nodeScript}`,
  );
  assert.ok(
    nodeScript.includes("tests/shared") && nodeScript.includes("tests/audit"),
    `test:node must cover tests/shared and tests/audit; got: ${nodeScript}`,
  );
  assert.ok(
    !nodeScript.includes("vitest"),
    `test:node must NOT use vitest (intentional split); got: ${nodeScript}`,
  );

  // remediate: vitest
  assert.ok(
    remediateScript.includes("vitest"),
    `test:remediate must use vitest; got: ${remediateScript}`,
  );

});

// ---------------------------------------------------------------------------
// FND-ARC-df11fab8: dominant unit — packages-audit-code file count
//
// Disposition: verified-already-satisfied.
//
// The finding reports 402/648 total files (62%) in the packages-audit-code
// unit. That metric includes every file in the package: tests/, schemas/,
// dispatch/, .gemini/, .gitignore, .npmignore, build wrappers, etc. The
// source code in src/ is decomposed into 12 subdirectories (adapters, cli,
// extractors, io, orchestrator, prompts, providers, quota, reporting,
// supervisor, types, validation). The file concentration is a consequence of
// the package being the larger of the two orchestrators — not a lack of
// decomposition within it. No further splitting is warranted; the package
// boundaries (audit-code / remediate-code / shared) represent the correct
// structural decomposition.
//
// Regression assertion: src/ subdirectory count stays >= 10 so a future
// collapse of subdirectories into a flat src/ cannot pass silently.
// ---------------------------------------------------------------------------

test("audit-code src/ is decomposed into at least 10 subdirectories (ARC-df11fab8)", async () => {
  const { readdir } = await import("node:fs/promises");
  const srcDir = join(pkgRoot, "src", "audit");
  const entries = await readdir(srcDir, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const expectedSubdirs = [
    "adapters",
    "cli",
    "extractors",
    "io",
    "orchestrator",
    "providers",
    "quota",
    "reporting",
    "supervisor",
    "types",
    "validation",
  ];

  assert.ok(
    subdirs.length >= 10,
    `audit-code src/ must have at least 10 subdirectories (structural decomposition); found ${subdirs.length}: ${subdirs.join(", ")}`,
  );

  for (const expected of expectedSubdirs) {
    assert.ok(
      subdirs.includes(expected),
      `audit-code src/ must contain '${expected}' subdirectory`,
    );
  }
});
