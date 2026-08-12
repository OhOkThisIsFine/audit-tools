/**
 * P25-a — the submission path is TOOL-OWNED, never host-typed.
 *
 * The measured drift (design record `docs/reviews/p25-design-check-2026-08-12.md`
 * §R2) is not on the host-handoff surface but on the flat `incoming/<filename>.json`
 * directory: the tool prints a filename into a host-facing prompt and then waits
 * for a file at exactly that name. A host that types it wrong — or renders it
 * through its own path handling — produces a submission the gate never sees, and
 * the run silently re-emits.
 *
 * The property this file pins is the one that makes that class impossible:
 *
 *   1. the gate registry (`HOST_GATE_DESCRIPTORS`) enumerates lanes, not
 *      host-typed filenames;
 *   2. no host-facing prompt or worker packet contains a literal submission
 *      filename or an `incoming/` path;
 *   3. the emitted step's declared write paths are the tool-computed
 *      `submissions/<sha256>.json` names;
 *   4. mechanically, across the whole of `src/`: no `join(..., "incoming", ...)`
 *      construction and no rendered `incoming/` literal survives.
 *
 * (4) is the guard that keeps (1)–(3) from being re-introduced one call site at a
 * time — *durable traps are mechanically enforced, not remembered*.
 *
 * NOTE: the emitted step contract is read as RAW JSON on purpose. `StepArtifactSchema`
 * is `.strict()` while `writeStepContract` injects `agent_id`, so `.parse()`ing the
 * emitted contract fails for reasons that have nothing to do with P25.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtureRepo } from "../audit/helpers/fixture.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.js");
const { buildAdvancedBundle } = await import("../audit/helpers/advancedBundle.mjs");
const { HOST_GATE_DESCRIPTORS } = await import("../../src/audit/cli/nextStepHelpers.js");

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Shape of the emitted step contract this test reads (raw JSON, never `.parse()`d). */
interface EmittedStep {
  step_kind: string;
  prompt_path: string;
  artifact_paths: Record<string, string>;
  access?: { read_paths?: string[]; write_paths?: string[] };
}

/** OS-agnostic: step-contract path fields are forward-slashed, disk paths are not. */
function slashed(candidate: string): string {
  return String(candidate).replace(/\\/g, "/");
}

/**
 * Drop comments before scanning source, so the guard is about CODE. Sweeping the
 * ~20 explanatory doc-comments that mention the retired directory is a separate
 * obligation of the same commit; a comment is not a path a host can mistype.
 * Only whole-line `//` comments are stripped, so a `https://` inside a string
 * literal is never mistaken for one.
 */
function stripComments(source: string): string {
  return source
    // Blank a block comment to its own newlines so reported line numbers stay true.
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

/**
 * Persist a bundle advanced to the design-review phase with the conceptual pass
 * already complete, leaving the SOLO `design_review_contract` branch — the
 * cheapest reachable gate that renders a submission path into a worker packet.
 * (Same fixture shape as `tests/audit/design-review-contract-independence.test.ts`.)
 */
async function persistSoloDesignReviewState(root: string, artifactsDir: string): Promise<void> {
  const bundle: ArtifactBundle = await buildAdvancedBundle(root, "design_review_contract_completed");
  if (!bundle.design_assessment) {
    throw new Error("advanced bundle missing design_assessment");
  }
  bundle.design_assessment = {
    ...bundle.design_assessment,
    conceptual_reviewed: true,
    conceptual_findings: [],
  };
  delete bundle.artifact_metadata;
  await mkdir(artifactsDir, { recursive: true });
  await writeCoreArtifacts(artifactsDir, bundle);
  await writeFile(
    join(artifactsDir, "analyzer-policy.json"),
    JSON.stringify(
      {
        analyzers: { typescript: "skip", python: "skip", html: "skip", css: "skip", sql: "skip" },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

describe("the submission path is tool-owned", () => {
  it("the host-gate registry enumerates lanes, not host-typed filenames", () => {
    const offenders: string[] = [];
    for (const [kind, descriptor] of Object.entries(HOST_GATE_DESCRIPTORS)) {
      const serialized = JSON.stringify(descriptor);
      // A host-typed `<name>.json` in the registry IS the guessable path: it is
      // the string the tool prints and the host retypes. Post-P25 a descriptor
      // names lanes; the filename is computed from the tool-minted submission id.
      for (const match of serialized.match(/[A-Za-z0-9_-]+\.json/g) ?? []) {
        offenders.push(`${kind}: ${match}`);
      }
      if (serialized.includes("incoming")) {
        offenders.push(`${kind}: references the retired incoming/ directory`);
      }
    }
    expect(
      offenders,
      "HOST_GATE_DESCRIPTORS must enumerate gate lanes, never host-typed submission filenames",
    ).toEqual([]);
  });

  it(
    "a driven design-review emission renders no submission filename into any host-facing prompt",
    { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS },
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "p25-submission-path-"));
      const root = join(tempDir, "repo");
      const artifactsDir = join(root, ".audit-tools/audit");
      try {
        await writeFixtureRepo(root);
        await persistSoloDesignReviewState(root, artifactsDir);

        await cmdNextStep(["--root", root]);
        const step: EmittedStep = JSON.parse(
          await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
        );
        expect(step.step_kind).toBe("design_review_contract");

        const packetPath = step.artifact_paths.contract_prompt;
        expect(packetPath, "the solo contract pass must still emit a worker packet").toBeTruthy();
        const packetText = await readFile(packetPath, "utf8");
        const hostPromptText = await readFile(step.prompt_path, "utf8");

        for (const [label, text] of [
          ["worker packet", packetText],
          ["host step prompt", hostPromptText],
        ] as const) {
          expect(
            text,
            `${label} must not name a host-typed submission file — the path is tool-owned`,
          ).not.toContain("design-review-contract-findings.json");
          expect(
            text,
            `${label} must not render an incoming/ path`,
          ).not.toContain("incoming");
        }

        const writePaths = (step.access?.write_paths ?? []).map(slashed);
        expect(writePaths.length, "the step must still declare its writable paths").toBeGreaterThan(
          0,
        );
        for (const writePath of writePaths) {
          expect(
            writePath,
            "every declared submission path is the tool-computed submissions/<sha256>.json name",
          ).toMatch(/\/submissions\/[0-9a-f]{64}\.json$/);
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("no source file constructs or renders a host-typed incoming/ path", async () => {
    const sources = await collectTypeScriptSources(join(repoRoot, "src"));
    expect(sources.length, "the src/ scan must actually reach files").toBeGreaterThan(50);

    const violations: string[] = [];
    for (const file of sources) {
      const code = stripComments(await readFile(file, "utf8"));
      code.split(/\r?\n/).forEach((line, index) => {
        // Two forms, both host-facing: the directory constructed as a path
        // segment (`join(artifactsDir, "incoming", …)`) and the literal
        // rendered into a prompt/packet body (`incoming/<name>.json`).
        if (/["'`]incoming["'`]/.test(line) || /incoming\//.test(line)) {
          violations.push(
            `${slashed(file.slice(repoRoot.length))}:${index + 1}: ${line.trim()}`,
          );
        }
      });
    }
    expect(
      violations,
      "the retired incoming/ directory must survive nowhere in src/ — not as a join() segment, not as a rendered literal",
    ).toEqual([]);
  });
});
