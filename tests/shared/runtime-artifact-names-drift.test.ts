import { describe, it, expect } from "vitest";
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_DEFINITIONS } from "../../src/audit/io/artifacts.js";
import {
  AUDIT_REPORT_FILENAME,
  AUDIT_FINDINGS_FILENAME,
  REMEDIATION_REPORT_FILENAME,
  REMEDIATION_OUTCOMES_FILENAME,
} from "../../src/shared/io/auditToolsPaths.js";
import { RUNTIME_ARTIFACT_NAMES } from "../../scripts/shared/runtime-artifact-names.generated.mjs";
import { RUNTIME_NAME_SOURCES } from "../../scripts/shared/generate-runtime-artifact-names.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** Tracked `src` TypeScript modules, excluding tests (a test's fixture constants are not layout). */
function trackedSourceModules(): string[] {
  return execFileSyncHidden("git", ["ls-files", "src/**/*.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(".test."));
}

/**
 * The declared source list is the ONE place a runtime-layout module is named —
 * and until this case existed nothing checked a module was IN it. The omission
 * class is exactly the one the drift test could not see: it cross-checked
 * `ARTIFACT_DEFINITIONS` coverage only, so a module that mints a basename
 * OUTSIDE that registry (`charter-extraction-merged.json`, `run-ledger.json`,
 * `intent-interpretation.json`) stayed missing while the gate's bare-name
 * resolution called the citation a repo file that does not exist.
 *
 * The rule is deliberately the NARROWEST unambiguous shape: a module that
 * EXPORTS a `SOMETHING_FILENAME = "<basename>"` constant. That is a module
 * asserting "this basename is my runtime layout", which is precisely what the
 * source list exists to collect; a merely-mentioned filename literal in a
 * `readFile` call is not, and stays out of scope so this cannot become a
 * false red over unrelated string literals.
 *
 * DECLARED *WITH THE RULE THAT COLLECTS IT*, not merely declared. The first
 * version of this guard asked only whether the file appeared in
 * RUNTIME_NAME_SOURCES, and that is file granularity for a rule-granular
 * decision: `src/audit/io/runArtifacts.ts` was listed for `joinLiterals` alone
 * while its `OPEN_REVIEW_WAVE_FILENAME` / `REVIEW_WAVE_CLOSED_FILENAME`
 * constants were never extracted, so `open-review-wave.json` and
 * `wave-closed.json` were both missing from the generated set and a doc citing
 * either was a false red — with this case passing vacuously. A module that
 * gains a `*_FILENAME` constant must also gain the rule that reads it, so the
 * guard now asks for BOTH.
 */
describe("runtime-artifact-names — every module that mints a FILENAME constant is declared", () => {
  it("no tracked src module exports a *_FILENAME constant outside RUNTIME_NAME_SOURCES", () => {
    const rulesByFile = new Map(
      RUNTIME_NAME_SOURCES.map((source) => [source.file, new Set(source.rules)]),
    );
    const offenders: string[] = [];
    for (const file of trackedSourceModules()) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const match of source.matchAll(
        /export const ([A-Z][A-Z0-9_]*FILENAME)\s*=\s*"([^"\\/\s]+\.[A-Za-z0-9]+)"/g,
      )) {
        if (rulesByFile.get(file)?.has("filenameConstants")) continue;
        offenders.push(
          `${file}  ${match[1]} = ${match[2]}` +
            (rulesByFile.has(file) ? "  (listed, but without the filenameConstants rule)" : ""),
        );
      }
    }
    expect(
      offenders,
      offenders.length
        ? `A module mints a runtime artifact basename but RUNTIME_NAME_SOURCES ` +
            `(scripts/shared/generate-runtime-artifact-names.mjs) does not collect it, so a doc ` +
            `citing that basename is a false red for naming a repo file that does not exist — ` +
            `add the module, or add "filenameConstants" to its row:\n  ${offenders.join("\n  ")}`
        : "",
    ).toEqual([]);
  });
});

/**
 * Drift pin for the generated run-artifact name set the doc-citation gate
 * consumes. The gate runs under plain node pre-build, so it imports the
 * generated `.mjs` sibling instead of the TypeScript registries — this test is
 * what keeps that sibling honest: it re-runs the extraction against the live
 * sources AND cross-checks the one true registry (`ARTIFACT_DEFINITIONS`)
 * directly, so a renamed artifact fails here instead of surfacing as a false
 * red (or a silently exempt citation) in the doc gate.
 */
describe("runtime-artifact-names.generated.mjs — drift against the layout sources", () => {
  it("every ARTIFACT_DEFINITIONS filename and deliverable name is in the set", () => {
    const names = new Set<string>(RUNTIME_ARTIFACT_NAMES);
    for (const [key, definition] of Object.entries(ARTIFACT_DEFINITIONS)) {
      expect(names.has(definition.fileName), `${key} → ${definition.fileName}`).toBe(true);
    }
    for (const deliverable of [
      AUDIT_REPORT_FILENAME,
      AUDIT_FINDINGS_FILENAME,
      REMEDIATION_REPORT_FILENAME,
      REMEDIATION_OUTCOMES_FILENAME,
    ]) {
      expect(names.has(deliverable), deliverable).toBe(true);
    }
  });

  it("the set is sorted, deduped, and free of suffix-test artifacts", () => {
    const names = [...RUNTIME_ARTIFACT_NAMES];
    expect(names).toEqual([...new Set(names)].sort());
    for (const name of names) {
      expect(name.startsWith("."), `leading-dot entry ${name}`).toBe(false);
      expect(name.includes("/"), `slashed entry ${name}`).toBe(false);
    }
  });
});
