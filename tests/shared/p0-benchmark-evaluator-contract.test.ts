import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { packageEvaluators, score } from "../../benchmarks/p0/runner.mjs";

const roots: string[] = [];
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileDigest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "p0-evaluator-contract-"));
  roots.push(root);
  const manifestPath = resolve("benchmarks/p0/manifest.json");
  const manifest = readJson(manifestPath);
  const requestIds = [...manifest.primary.pairs, ...manifest.held_out.pairs]
    .flatMap((pair: { id: string }) => [`${pair.id}-A`, `${pair.id}-B`]);
  const records = requestIds.map((requestId: string) => {
    const artifactPath = join(root, `${requestId}.md`);
    writeFileSync(artifactPath, `# ${requestId}\n`);
    return {
      request_id: requestId,
      response: {
        artifact_path: artifactPath,
        artifact_sha256: fileDigest(artifactPath),
      },
    };
  });
  const rawPath = join(root, "raw.json");
  const graphPath = join(root, "graph.json");
  writeJson(rawPath, {
    protocol: "p0-raw-results-v1",
    manifest_digest: digest(manifest),
    records,
  });
  writeJson(graphPath, {
    protocol: "p0-graph-disabled-v1",
    manifest_digest: digest(manifest),
    graph_enabled: false,
    outcome: "abort_before_comprehensive",
    comprehensive_started: false,
  });
  return { root, manifestPath, manifest, rawPath, graphPath, records };
}

function passingAggregate(axes: string[]) {
  return {
    evaluator_coverage: { independent: 2, adjudicated: true },
    primary: {
      ties_or_wins: 5,
      candidate_runs_recovering_strongest: 5,
      median_by_axis: Object.fromEntries(
        axes.map((axis) => [axis, { candidate: 0.8, control: 0.8 }]),
      ),
    },
    admitted_high_confidence_unsupported: 0,
    held_out: {
      seeded_positive_rate: { candidate: 1, control: 1 },
      negative_control_false_positive_rate: { candidate: 0, control: 0 },
    },
  };
}

function evaluation(packetSummary: Record<string, string>, evaluatorId: string, disagree = false) {
  const packet = readJson(packetSummary.packet_path);
  return {
    protocol: "p0-blinded-evaluation-v1",
    evaluator_id: evaluatorId,
    packet_path: packetSummary.packet_path,
    packet_id: packetSummary.packet_id,
    packet_digest: packetSummary.packet_digest,
    scores: packet.reports.map((report: { blinded_id: string }, index: number) => ({
      blinded_id: report.blinded_id,
      axes: Object.fromEntries(
        packet.axes.map((axis: string) => [
          axis,
          disagree && index === 0 && axis === "structural_recall" ? 0.7 : 0.8,
        ]),
      ),
    })),
  };
}

describe("P0 evaluator packet provenance", () => {
  test.each(["arbitrary", "missing", "duplicate"])(
    "rejects %s raw request-id coverage",
    (kind) => {
      const state = fixture();
      const raw = readJson(state.rawPath);
      if (kind === "arbitrary") raw.records[0].request_id = "arbitrary-A";
      if (kind === "missing") raw.records.pop();
      if (kind === "duplicate") raw.records[0].request_id = raw.records[1].request_id;
      writeJson(state.rawPath, raw);
      expect(() =>
        packageEvaluators(
          state.manifestPath,
          state.rawPath,
          state.graphPath,
          join(state.root, "packets"),
        ),
      ).toThrow(/20 complete raw reports/i);
    },
  );

  test("packages two self-digested packets and validates bound independent evaluations", () => {
    const state = fixture();
    const packaged = packageEvaluators(
      state.manifestPath,
      state.rawPath,
      state.graphPath,
      join(state.root, "packets"),
    );
    expect(packaged.protocol).toBe("p0-evaluator-package-v1");
    expect(packaged.packets).toHaveLength(2);
    expect(new Set(packaged.packets.map((packet) => packet.packet_id)).size).toBe(2);
    for (const summary of packaged.packets) {
      const packet = readJson(summary.packet_path);
      const { packet_digest: packetDigest, ...content } = packet;
      expect(packet.reports).toHaveLength(20);
      expect(packetDigest).toBe(digest(content));
      expect(summary.packet_digest).toBe(packetDigest);
      expect(JSON.stringify(packet)).not.toMatch(/\b(?:control|candidate)\b/i);
    }

    const evaluations = [
      evaluation(packaged.packets[0], "reviewer-1"),
      evaluation(packaged.packets[1], "reviewer-2", true),
    ];
    const input = {
      evaluator_input: {
        protocol: "p0-independent-evaluations-v1",
        evaluations,
      },
      adjudication: {
        protocol: "p0-adjudication-v1",
        packet_digests: packaged.packets.map((packet) => packet.packet_digest),
        resolutions: [
          {
            disagreement_id: "R-01:structural_recall",
            value: 0.75,
            rationale: "independent evidence review",
          },
        ],
      },
      score: passingAggregate(state.manifest.axes),
    };
    const inputPath = join(state.root, "score-input.json");
    writeJson(inputPath, input);
    expect(score(inputPath)).toBe(true);

    const invalid: Array<[string, (copy: any) => void]> = [
      ["reused packet", (copy) => Object.assign(copy.evaluator_input.evaluations[1], {
        packet_path: copy.evaluator_input.evaluations[0].packet_path,
        packet_id: copy.evaluator_input.evaluations[0].packet_id,
        packet_digest: copy.evaluator_input.evaluations[0].packet_digest,
      })],
      ["reused evaluator", (copy) => {
        copy.evaluator_input.evaluations[1].evaluator_id = "reviewer-1";
      }],
      ["incomplete scores", (copy) => {
        copy.evaluator_input.evaluations[0].scores.pop();
      }],
      ["identity leak", (copy) => {
        copy.evaluator_input.evaluations[0].private_arm_identity = "candidate";
      }],
      ["missing adjudication", (copy) => {
        copy.adjudication.resolutions = [];
      }],
      ["extra adjudication", (copy) => {
        copy.adjudication.resolutions.push({ disagreement_id: "R-20:reduction_value", value: 0.5, rationale: "fabricated" });
      }],
      ["duplicate adjudication", (copy) => {
        copy.adjudication.resolutions.push({ ...copy.adjudication.resolutions[0] });
      }],
      ["wrong digest", (copy) => {
        copy.evaluator_input.evaluations[0].packet_digest = "0".repeat(64);
      }],
    ];
    for (const [name, mutate] of invalid) {
      const copy = structuredClone(input);
      mutate(copy);
      const invalidPath = join(state.root, `${name.replaceAll(" ", "-")}.json`);
      writeJson(invalidPath, copy);
      expect(() => score(invalidPath), name).toThrow();
    }

    const tamperedPacket = readJson(packaged.packets[0].packet_path);
    tamperedPacket.reports[0].report_sha256 = "0".repeat(64);
    const tamperedPath = join(state.root, "tampered.packet.json");
    writeJson(tamperedPath, tamperedPacket);
    const tamperedInput = structuredClone(input);
    tamperedInput.evaluator_input.evaluations[0].packet_path = tamperedPath;
    const tamperedInputPath = join(state.root, "tampered-score.json");
    writeJson(tamperedInputPath, tamperedInput);
    expect(() => score(tamperedInputPath)).toThrow(/valid blinded packet/i);
  });
});
