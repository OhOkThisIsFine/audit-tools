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
// A lane prompt is a prompt BODY, so every absolute path inside it is written in
// the forward-slashed host-facing form — the same form `writeStepContract` uses
// for the step contract beside it (owner review 2026-09-17, prompts 13 and 14).
// `lane.resultPath` is the native path, so a test must normalize before matching.
import { toPromptPathToken } from "../../src/shared/tooling/exec.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const FAKE_ARTIFACTS_DIR = "/project/.audit-tools/remediation";

const ALL_PATHS = Object.fromEntries(
  CP_ARTIFACT_NAMES.map((name) => [
    name,
    contractInputFilePath(FAKE_ARTIFACTS_DIR, name),
  ]),
) as Record<ContractPipelineArtifactName, string>;

// The recognizers live in the shared helper so the guard-form-reach test can
// drive the REAL matchers over each declared sample (P51).
import { requiredInputEntries, resultsPathDriftLines } from "../helpers/recognizers.js";

/** OS-agnostic reporting for src-scan violations. */
function slashed(candidate: string): string {
  return String(candidate).replace(/\\/g, "/");
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

  // Artifacts the TOOL writes after the last worker phase, each with the writer
  // that produces it. Prompt 18 retired the `closing` worker text: no worker phase
  // writes `verification_report`, the close phase builds it.
  const toolWritten = new Map<ContractPipelineArtifactName, string>([
    ["verification_report", "buildVerificationReport (src/remediate/phases/close.ts), after every phase"],
  ]);

  it("every contract-pipeline artifact has exactly one producing phase, or a named tool writer", () => {
    const producerless = CP_ARTIFACT_NAMES.filter(
      (name) => !artifactToPhase.has(name) && !toolWritten.has(name),
    );
    expect(
      producerless,
      "an artifact no phase produces can be NAMED as an input but never written",
    ).toEqual([]);
    for (const name of toolWritten.keys()) {
      expect(
        artifactToPhase.has(name),
        `${name} is declared tool-written but a phase also produces it`,
      ).toBe(false);
    }
  });

  it("every DEPENDENCY_MAP dependency is produced strictly earlier in the phase order", () => {
    const violations: string[] = [];
    for (const name of CP_ARTIFACT_NAMES) {
      // A tool-written artifact is produced after the last phase.
      const ownIndex = toolWritten.has(name)
        ? CONTRACT_PIPELINE_PHASE_ORDER.length
        : CONTRACT_PIPELINE_PHASE_ORDER.indexOf(artifactToPhase.get(name)!);
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
        ).toContain(toPromptPathToken(lane.resultPath));
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
      expect(alpha).not.toContain(toPromptPathToken(fanout.lanes[1]!.resultPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The footer's own path is normalized where the footer is built, so the test
  // above cannot see the SECOND half of the path-form fix: a path the CALLER
  // wrote into the prompt body. The synthesis-narrative prompt is exactly that
  // case — its overflow line names the findings report — and a lane that reads
  // one path form in its prompt body and another in the step contract beside it
  // cannot tell whether the two name one file (owner review 2026-09-17, prompts
  // 13 and 14: fix the class, with a contract test).
  it("materializeFanoutLanes forward-slashes an absolute path written into the prompt BODY", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c2-lane-body-paths-"));
    try {
      const windowsPath = String.raw`C:\Code\audit-tools\.audit-tools\audit\audit-findings.json`;
      const uncPath = String.raw`\\build01\share\.audit-tools\audit\audit-findings.json`;
      const fanout = await materializeFanoutLanes({
        artifactsDir: dir,
        runId: "c2-body-path-scope",
        lanes: [
          {
            id: "lane_body",
            label: "Body",
            promptFilename: "body-prompt.md",
            promptText: [
              "# Body",
              "",
              `Read the complete report at ${windowsPath} when a theme needs it.`,
              `The mirror lives at ${uncPath}.`,
              "",
              "Match an id with /^F-\\d+$/ — a regex is not a path.",
            ].join("\n"),
          },
        ],
      });

      const text = (await readFile(fanout.lanes[0]!.promptPath, "utf8")).replace(
        /\r\n/g,
        "\n",
      );
      expect(
        text,
        "a drive-letter path the caller wrote into the body is forward-slashed",
      ).toContain("C:/Code/audit-tools/.audit-tools/audit/audit-findings.json");
      expect(
        text,
        "a UNC path is normalized the same way",
      ).toContain("//build01/share/.audit-tools/audit/audit-findings.json");
      expect(text, "no backslashed form survives").not.toContain(windowsPath);
      expect(
        text,
        "the normalizer is anchored on a path root, so a regex in the body is untouched",
      ).toContain(String.raw`/^F-\d+$/`);
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
      // A second "## Results path" section is a second place the bound path
      // and its alternative can drift out of agreement; "…provided below"
      // promises a section this renderer does not emit — the dangling
      // reference that left every conceptual lane pathless.
      for (const hit of resultsPathDriftLines(await readFile(file, "utf8"))) {
        violations.push(`${slashed(file.slice(repoRoot.length))}:${hit.line}: ${hit.text}`);
      }
    }
    expect(
      violations,
      "the results-path section is minted once, at the lane chokepoint that owns the bound path",
    ).toEqual([]);
  });
});
