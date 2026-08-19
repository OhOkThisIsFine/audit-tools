/**
 * C2 (sol-10 / P35) — PROMPT CAPABILITY: every imperative a rendered prompt
 * gives a worker must be satisfiable by the worker it is handed to.
 *
 * Two failure classes, one property. Both were live at HEAD, both were logged as
 * backlog friction rather than enforced, and both are the kind of thing "the
 * host will notice" — which is exactly what this repo bans.
 *
 *   1. **ENOENT inputs.** A prompt lists a "## Required Inputs" path that no
 *      producer ever writes. The fix is DERIVATION: the required-input list is
 *      read off the artifact store's `DEPENDENCY_MAP` (one truth for staleness
 *      AND for prompts), and every tool-derived artifact is materialized at the
 *      host-facing input path as well as the canonical envelope. A hand-kept
 *      per-role list could drift from the write map; a derived one cannot.
 *
 *   2. **Unsatisfiable write imperatives.** A lane prompt orders "write the JSON
 *      object to <path>" with no alternative, so a read-only executor has no
 *      sanctioned way to deliver its answer at all. The write instruction must
 *      STAY (the bound path is what `tryConsumeSubmission` reads); what was
 *      missing is the stated fallback — return the object as the final message
 *      and let the dispatching agent write it verbatim.
 *
 * Scope: MAP-LEVEL and RENDER-LEVEL only. Whether a given path exists on disk at
 * a given moment is a run property, pinned by the targeted single-phase scenario
 * in `tests/remediate/contract-pipeline-required-inputs.test.ts` — a blanket
 * disk rule would be a false positive on a collapsed framing step, which
 * legitimately names paths written later in the same round-trip.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEPENDENCY_MAP,
  CP_ARTIFACT_NAMES,
  contractArtifactFilePath,
  contractInputFilePath,
  isEnvelope,
  readContractArtifact,
  writeDerivedContractArtifact,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import type { ContractPipelineArtifactName } from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  CONTRACT_PIPELINE_PHASE_ORDER,
  PHASE_TO_ARTIFACT,
  ROLES,
  renderContractPipelinePrompt,
} from "../../src/remediate/steps/contractPipelinePrompts.js";
import {
  LANE_RESULT_FALLBACK_SENTENCE,
  LANE_RESULTS_HEADING,
  materializeFanoutLanes,
  renderLaneResultsFooter,
} from "../../src/audit/cli/fanoutLanes.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const FAKE_ARTIFACTS_DIR = "/project/.audit-tools/remediation";

const ALL_PATHS = Object.fromEntries(
  CP_ARTIFACT_NAMES.map((name) => [
    name,
    contractInputFilePath(FAKE_ARTIFACTS_DIR, name),
  ]),
) as Record<ContractPipelineArtifactName, string>;

/** The `- \`<path>\` (<key>)` entries a rendered "## Required Inputs" block lists. */
function requiredInputEntries(prompt: string): Array<{ path: string; key: string }> {
  const section = prompt.split(/^## Required Inputs$/m)[1];
  if (section === undefined) return [];
  const body = section.split(/^## /m)[0]!;
  return [...body.matchAll(/^- `([^`]+)` \(([a-z_]+)\)$/gm)].map((match) => ({
    path: match[1]!,
    key: match[2]!,
  }));
}

/** OS-agnostic reporting for src-scan violations. */
function slashed(candidate: string): string {
  return String(candidate).replace(/\\/g, "/");
}

/**
 * Drop comments before scanning source, so the guard is about CODE (precedent:
 * `tests/shared/submission-path-is-tool-owned.test.ts`). Only whole-line `//`
 * comments are stripped, so a `https://` inside a string literal is never
 * mistaken for one.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

async function collectTypeScriptSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ── 1. Producer soundness ─────────────────────────────────────────────────────

describe("every declared input has a producer that runs BEFORE it", () => {
  const artifactToPhase = new Map<ContractPipelineArtifactName, string>(
    Object.entries(PHASE_TO_ARTIFACT).map(([phase, artifact]) => [artifact, phase]),
  );

  it("every contract-pipeline artifact has exactly one producing phase", () => {
    const producerless = CP_ARTIFACT_NAMES.filter(
      (name) => !artifactToPhase.has(name),
    );
    expect(
      producerless,
      "an artifact no phase produces can be NAMED as an input but never written",
    ).toEqual([]);
  });

  it("every DEPENDENCY_MAP dependency is produced strictly earlier in the phase order", () => {
    const violations: string[] = [];
    for (const name of CP_ARTIFACT_NAMES) {
      const ownIndex = CONTRACT_PIPELINE_PHASE_ORDER.indexOf(
        artifactToPhase.get(name)!,
      );
      for (const dep of DEPENDENCY_MAP[name]) {
        const depPhase = artifactToPhase.get(dep);
        if (depPhase === undefined) {
          violations.push(`${name} depends on ${dep}, which no phase produces`);
          continue;
        }
        const depIndex = CONTRACT_PIPELINE_PHASE_ORDER.indexOf(depPhase);
        if (depIndex >= ownIndex) {
          violations.push(
            `${name} (phase ${ownIndex}) depends on ${dep} (phase ${depIndex}) — not strictly earlier`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── 2. Derivation: prompts read the write/dependency map ──────────────────────

describe("a role's Required Inputs are DERIVED from DEPENDENCY_MAP", () => {
  for (const roleName of Object.keys(ROLES)) {
    it(`${roleName} lists exactly DEPENDENCY_MAP[${ROLES[roleName]!.outputKey}]`, () => {
      const role = ROLES[roleName]!;
      const result = renderContractPipelinePrompt({
        role: roleName,
        artifactPaths: ALL_PATHS,
      });
      const entries = requiredInputEntries(result.prompt);
      expect(entries.map((entry) => entry.key)).toEqual([
        ...DEPENDENCY_MAP[role.outputKey],
      ]);
      for (const entry of entries) {
        expect(
          entry.path,
          `${roleName} must name the resolved artifact path for ${entry.key}`,
        ).toBe(ALL_PATHS[entry.key as ContractPipelineArtifactName]);
      }
    });
  }

  it("the role table carries no second, hand-kept copy of the input list", () => {
    for (const [roleName, role] of Object.entries(ROLES)) {
      expect(
        Object.keys(role),
        `${roleName} must not re-declare its inputs — DEPENDENCY_MAP is the single truth`,
      ).not.toContain("requiredInputKeys");
    }
  });
});

// ── 3. Materialization: a derived artifact reaches the HOST-facing path ────────

describe("a tool-derived artifact is written where the prompt says to read it", () => {
  it("writeDerivedContractArtifact leaves a plain payload at the input path and an envelope at the canonical path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c2-derived-artifact-"));
    try {
      const payload = {
        contract_version: "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
        goal_id: "G1",
        obligations: [],
        created_at: "2026-01-01T00:00:00.000Z",
      };
      await writeDerivedContractArtifact(dir, "obligation_ledger", payload);

      const hostFacing = JSON.parse(
        await readFile(contractInputFilePath(dir, "obligation_ledger"), "utf8"),
      );
      expect(
        isEnvelope(hostFacing),
        "the host's world is the PLAIN payload — never the tool's envelope",
      ).toBe(false);
      expect(hostFacing).toEqual(payload);

      const canonical = JSON.parse(
        await readFile(contractArtifactFilePath(dir, "obligation_ledger"), "utf8"),
      );
      expect(isEnvelope(canonical)).toBe(true);
      const envelope = await readContractArtifact(dir, "obligation_ledger");
      expect(envelope?.payload).toEqual(payload);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── 4. Lane capability: the write imperative is satisfiable ───────────────────

describe("every fan-out lane prompt states a bound path AND a read-only alternative", () => {
  it("materializeFanoutLanes appends the footer, with each lane's own bound path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c2-lane-capability-"));
    try {
      const fanout = await materializeFanoutLanes({
        artifactsDir: dir,
        runId: "c2-capability-scope",
        lanes: [
          {
            id: "lane_alpha",
            label: "Alpha",
            promptFilename: "alpha-prompt.md",
            promptText: "# Alpha\n\nDo the alpha work.",
          },
          {
            id: "lane_beta",
            label: "Beta",
            promptFilename: "beta-prompt.md",
            promptText: "# Beta\n\nDo the beta work.",
            expected: false,
          },
        ],
      });

      expect(fanout.lanes).toHaveLength(2);
      for (const lane of fanout.lanes) {
        const text = (await readFile(lane.promptPath, "utf8")).replace(/\r\n/g, "\n");
        expect(
          text,
          `${lane.id} must state its own tool-bound result path`,
        ).toContain(lane.resultPath);
        expect(text).toContain(LANE_RESULTS_HEADING);
        expect(
          text,
          `${lane.id} must offer the read-only executor a sanctioned way to deliver`,
        ).toContain(LANE_RESULT_FALLBACK_SENTENCE);
        expect(
          text.endsWith(renderLaneResultsFooter(lane.resultPath)),
          `${lane.id} must carry the footer verbatim, at the end`,
        ).toBe(true);
        // The write instruction is NOT replaced by the alternative: the bound
        // path is what the tool's submission reader consumes.
        expect(text).toMatch(/Write your submission/);
      }
      // Another lane's bound path never leaks into this lane's prompt.
      const alpha = await readFile(fanout.lanes[0]!.promptPath, "utf8");
      expect(alpha).not.toContain(fanout.lanes[1]!.resultPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no source file outside the lane chokepoint renders its own results-path section", async () => {
    const sources = await collectTypeScriptSources(join(repoRoot, "src"));
    expect(sources.length, "the src/ scan must actually reach files").toBeGreaterThan(50);
    const chokepoint = join(repoRoot, "src", "audit", "cli", "fanoutLanes.ts");

    const violations: string[] = [];
    for (const file of sources) {
      if (file === chokepoint) continue;
      const code = stripComments(await readFile(file, "utf8"));
      code.split(/\r?\n/).forEach((line, index) => {
        const where = `${slashed(file.slice(repoRoot.length))}:${index + 1}: ${line.trim()}`;
        // A second "## Results path" section is a second place the bound path
        // and its alternative can drift out of agreement.
        if (line.includes(LANE_RESULTS_HEADING)) {
          violations.push(where);
        }
        // "…provided below" promises a section this renderer does not emit —
        // the dangling reference that left every conceptual lane pathless.
        if (/results path provided below/i.test(line)) {
          violations.push(where);
        }
      });
    }
    expect(
      violations,
      "the results-path section is minted once, at the lane chokepoint that owns the bound path",
    ).toEqual([]);
  });
});
