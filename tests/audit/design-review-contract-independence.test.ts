/**
 * Design-review independence — the SOLO `design_review_contract` branch.
 *
 * Property: no design-review pass is judged by the agent that drove the work
 * under review. `design_review_parallel` dispatches the contract pass to a
 * subagent (pinned in next-step.test.mjs) and solo `design_review_conceptual`
 * dispatches through `prepareConceptualDispatch`; the solo contract branch —
 * reached whenever ONLY the contract pass is missing or has re-staled — used to
 * render the adversarial review body straight into the host's own step prompt,
 * so the host reviewed artifacts it had itself driven.
 *
 * The dispatch shape is therefore asserted on both halves: the worker packet
 * carries the review body and NO advance command (a worker that runs `next-step`
 * becomes a second driver of the orchestrator), and the host step prompt carries
 * the dispatch instruction + the advance and NOT the review body.
 */
import { test, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixtureRepo } from "./helpers/fixture.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.js");
const { buildAdvancedBundle } = await import("./helpers/advancedBundle.mjs");
const { GATE_LANES, laneSubmissionPath } = await import(
  "../../src/audit/cli/laneSubmissions.js"
);

/**
 * The contract pass's bound submission path, asked of the tool rather than
 * re-spelled. Post-P25 the name is a digest, so a shape-only assertion
 * (`/submissions/<hex>.json`) would pass for ANY lane's submission — it proves
 * the naming scheme and loses the identity. This asserts the exact path the
 * `design_review_contract` LANE binds.
 */
function contractSubmissionPath(artifactsDir: string): string {
  return laneSubmissionPath(artifactsDir, GATE_LANES.design_review_contract).replace(
    /\\/g,
    "/",
  );
}

interface DesignReviewStep {
  step_kind: string;
  prompt_path: string;
  artifact_paths: Record<string, string>;
  access?: {
    read_paths: string[];
    write_paths: string[];
  };
}

/** OS-agnostic tail match — the step contract forward-slashes host-facing paths. */
function endsWithPath(candidate: string, tail: string): boolean {
  return String(candidate).replace(/\\/g, "/").endsWith(tail);
}

/**
 * Persist a bundle advanced to the design-review phase. With
 * `conceptualDone: true` the conceptual pass reads as complete (legacy flag, no
 * snapshot ⇒ not stale), leaving the contract pass as the only outstanding one —
 * the SOLO `design_review_contract` branch; otherwise both passes are
 * outstanding and the PARALLEL branch fires. Metadata is dropped so the
 * hand-shaped design_assessment reads as a valid first-run (presence-based
 * staleness) rather than re-staling and rebuilding itself, which would wipe the
 * conceptual flag.
 */
async function persistDesignReviewState(
  root: string,
  artifactsDir: string,
  { conceptualDone }: { conceptualDone: boolean },
): Promise<void> {
  const bundle: ArtifactBundle = await buildAdvancedBundle(
    root,
    "design_review_contract_completed",
  );
  if (conceptualDone) {
    if (!bundle.design_assessment) {
      throw new Error("advanced bundle missing design_assessment");
    }
    bundle.design_assessment = {
      ...bundle.design_assessment,
      conceptual_reviewed: true,
      conceptual_findings: [],
    };
  }
  delete bundle.artifact_metadata;
  await mkdir(artifactsDir, { recursive: true });
  await writeCoreArtifacts(artifactsDir, bundle);
  await writeFile(
    join(artifactsDir, "analyzer-policy.json"),
    JSON.stringify(
      {
        analyzers: {
          typescript: "skip",
          python: "skip",
          html: "skip",
          css: "skip",
          sql: "skip",
        },
      },
      null,
      2,
    ) + "\n",
  );
}

test(
  "solo design_review_contract dispatches an advance-free worker packet instead of reviewing inline",
  { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "audit-code-dr-contract-"));
    const root = join(tempDir, "repo");
    const artifactsDir = join(root, ".audit-tools/audit");
    try {
      await writeFixtureRepo(root);
      await persistDesignReviewState(root, artifactsDir, { conceptualDone: true });

      await cmdNextStep(["--root", root]);
      const step: DesignReviewStep = JSON.parse(
        await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
      );
      expect(step.step_kind).toBe("design_review_contract");

      // A dispatched worker packet exists at all — the solo pass is delegated,
      // not folded into the host's own prompt.
      const packetPath = step.artifact_paths.contract_prompt;
      expect(
        packetPath,
        "solo contract pass must emit a worker packet (contract_prompt), not review inline",
      ).toBeTruthy();
      expect(endsWithPath(packetPath, "lanes/design-review-contract-prompt.md")).toBe(true);

      const packet = await readFile(packetPath, "utf8");
      expect(packet).toContain("Project contract review (adversarial pass)");
      // Post-P25 the packet embeds the TOOL-COMPUTED submission path, not a
      // filename a worker could retype. Separator-agnostic: the packet carries
      // the OS-native path, while the step contract forward-slashes every
      // host-facing field.
      expect(packet.replaceAll("\\", "/")).toContain(
        contractSubmissionPath(artifactsDir),
      );
      expect(packet).not.toContain("design-review-contract-findings.json");
      // Advance-free: the same double-driver guard the parallel branch carries.
      expect(packet).not.toContain("Then run:");

      // The host drives the dispatch and owns the advance — it does not perform
      // the adversarial review over artifacts it drove.
      const hostPrompt = await readFile(step.prompt_path, "utf8");
      expect(
        hostPrompt,
        "the host step prompt must not carry the contract-review body (that is the subagent's packet)",
      ).not.toContain("Project contract review (adversarial pass)");
      expect(hostPrompt).toContain("dispatch a subagent");
      expect(hostPrompt).toContain("have been written, run:");

      // Packet readable / results writable are pre-declared, as in the parallel branch.
      expect(
        (step.access?.read_paths ?? []).some((p) =>
          endsWithPath(p, "lanes/design-review-contract-prompt.md"),
        ),
        "the contract packet must be declared readable",
      ).toBe(true);
      expect(
        (step.access?.write_paths ?? []).map((p) => p.replaceAll("\\", "/")),
        "the contract results path must be declared writable, at the exact path its LANE binds",
      ).toContain(contractSubmissionPath(artifactsDir));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "parallel design_review dispatch keeps the same contract-packet shape (both branches share one preparer)",
  { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "audit-code-dr-parallel-"));
    const root = join(tempDir, "repo");
    const artifactsDir = join(root, ".audit-tools/audit");
    try {
      await writeFixtureRepo(root);
      await persistDesignReviewState(root, artifactsDir, { conceptualDone: false });

      await cmdNextStep(["--root", root]);
      const step: DesignReviewStep = JSON.parse(
        await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
      );
      expect(step.step_kind).toBe("design_review_parallel");

      const packet = await readFile(step.artifact_paths.contract_prompt, "utf8");
      expect(packet).toContain("Project contract review (adversarial pass)");
      expect(packet).not.toContain("Then run:");

      const hostPrompt = await readFile(step.prompt_path, "utf8");
      expect(hostPrompt).not.toContain("Project contract review (adversarial pass)");
      expect(hostPrompt).toContain("1. **Contract review** (adversarial): dispatch a subagent");
      expect(hostPrompt).toContain("both been written, run:");

      expect(
        (step.access?.read_paths ?? []).some((p) =>
          endsWithPath(p, "lanes/design-review-contract-prompt.md"),
        ),
      ).toBe(true);
      expect(
        (step.access?.write_paths ?? []).map((p) => p.replaceAll("\\", "/")),
      ).toContain(contractSubmissionPath(artifactsDir));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);
