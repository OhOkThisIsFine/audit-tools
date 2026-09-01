import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { packageEvaluators, score } from "../../benchmarks/p0/runner.mjs";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

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

function executorResponse(request: unknown, artifactPath: string, profile: unknown) {
  return {
    protocol: "p0-executor-response-v1",
    request_digest: digest(request),
    pinned_profile: profile,
    artifact_path: artifactPath,
    artifact_sha256: fileDigest(artifactPath),
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "p0-evaluator-contract-"));
  roots.push(root);
  const manifestPath = resolve("benchmarks/p0/manifest.json");
  const manifest = readJson(manifestPath);
  const preparedRoot = join(root, "prepared");
  const prepared = spawnSyncHidden(
    process.execPath,
    [
      resolve("benchmarks/p0/runner.mjs"),
      "prepare",
      "--manifest",
      manifestPath,
      "--output",
      preparedRoot,
    ],
    { encoding: "utf8" },
  );
  if (prepared.status !== 0)
    throw Error(`fixture prepare failed: ${prepared.stderr || prepared.stdout}`);
  const requests = readJson(join(preparedRoot, "requests.public.json"));
  const identityPath = join(preparedRoot, "identity.private.json");
  const identity = readJson(identityPath);
  const goldPath = join(root, "private-gold.json");
  const cases = [
    ["fixture-primary-one", "primary", "positive", true],
    ["fixture-primary-two", "primary", "positive", true],
    ["fixture-primary-three", "primary", "positive", true],
    ["fixture-primary-four", "primary", "positive", true],
    ["fixture-primary-five", "primary", "unscored", false],
    ["fixture-held-one", "held_out", "positive", false],
    ["fixture-held-two", "held_out", "positive", false],
    ["fixture-held-three", "held_out", "negative", false],
    ["fixture-held-four", "held_out", "negative", false],
    ["fixture-held-five", "held_out", "unscored", false],
  ].map(([privateId, group, sign, strongest], index) => ({
    private_id: privateId,
    group,
    subject: `Private operator description ${index + 1}`,
    evidence_focus:
      `Private operator evidence focus ${index + 1} that is available only during adjudication.`,
    sign,
    strongest,
  }));
  const gold = {
    protocol: "p0-private-gold-v1",
    manifest_digest: digest(manifest),
    cases,
  };
  writeJson(goldPath, gold);

  const records = requests.requests.map((request: any, index: number) => {
    const artifactPath = join(root, `source-report-${index + 1}.md`);
    writeFileSync(artifactPath, `# Blinded benchmark report ${index + 1}\n`);
    const kind = identity.arms[request.pair_id][request.arm];
    if (kind === "control") {
      const executionRequest = { ...request, execution: "standalone" };
      return {
        request_id: request.request_id,
        request_digest: digest(request),
        response: executorResponse(
          executionRequest,
          artifactPath,
          request.pinned_profile,
        ),
      };
    }
    const stepArtifact = join(root, `step-artifact-${index + 1}.json`);
    writeFileSync(stepArtifact, `{"ok":${index + 1}}\n`);
    const stepRequest = {
      protocol: "p0-step-request-v1",
      step_id: `semantic-${index + 1}`,
      prompt: "Review the blinded snapshot and return bound evidence.",
      artifact_path: `.audit-tools/audit/evidence-${index + 1}.json`,
      snapshot_root: join(root, `snapshot-${index + 1}`),
      pinned_profile: request.pinned_profile,
    };
    return {
      request_id: request.request_id,
      request_digest: digest(request),
      final_step: {
        step_id: `present-report-${index + 1}`,
        step_kind: "present_report",
        complete: true,
        artifact_path: ".audit-tools/audit/audit-report.md",
      },
      step_responses: [
        {
          request: stepRequest,
          response: executorResponse(
            stepRequest,
            stepArtifact,
            request.pinned_profile,
          ),
        },
      ],
      snapshot_commit:
        request.snapshot === "primary" ? manifest.shared.repo_commit : null,
      source_tree_clean: true,
      response: {
        artifact_path: artifactPath,
        artifact_sha256: fileDigest(artifactPath),
      },
    };
  });
  const rawPath = join(root, "raw.json");
  const graphPath = join(root, "graph.json");
  const provenancePath = join(root, "scoring-provenance.private.json");
  writeJson(rawPath, {
    protocol: "p0-raw-results-v1",
    manifest_digest: digest(manifest),
    identity_digest: digest(identity),
    records,
  });
  writeJson(graphPath, {
    protocol: "p0-graph-disabled-v1",
    manifest_digest: digest(manifest),
    graph_enabled: false,
    outcome: "abort_before_comprehensive",
    notice: manifest.graph_disabled_trial.notice,
    comprehensive_started: false,
  });
  return {
    root,
    manifestPath,
    manifest,
    requests,
    rawPath,
    graphPath,
    identityPath,
    provenancePath,
    goldPath,
    gold,
    identity,
    records,
  };
}

function packageFixture(state: ReturnType<typeof fixture>) {
  return packageEvaluators(
    state.manifestPath,
    state.rawPath,
    state.graphPath,
    state.identityPath,
    join(state.root, "packets"),
    state.provenancePath,
    state.goldPath,
  );
}

function privateContext(packaged: any) {
  const provenance = readJson(packaged.private_provenance_path);
  return { provenance, gold: readJson(provenance.gold_path) };
}

function fixtureClaims(packaged: any, blindedId: string) {
  const { provenance, gold } = privateContext(packaged);
  const binding = provenance.report_bindings.find(
    (item: any) => item.blinded_id === blindedId,
  );
  return gold.cases
    .filter(
      (item: any) => item.group === binding.gold_group && item.sign !== "unscored",
    )
    .map((item: any, index: number) => ({
      private_id: item.private_id,
      claim: {
        normalized_finding_text: `observed report relationship ${index + 1}`,
        treatment:
          item.sign === "negative" ? "explicitly_defended" : "finding",
        support: "supported",
        confidence: 0.9,
        evidence: `Independent report evidence for relationship ${index + 1}`,
      },
    }));
}

type Disagreements = { axis?: boolean; claim?: boolean };

function evaluation(
  packaged: any,
  packetIndex: number,
  evaluatorId: string,
  disagreements: Disagreements = {},
) {
  const packetSummary = packaged.packets[packetIndex];
  const packet = readJson(packetSummary.packet_path);
  return {
    protocol: "p0-blinded-evaluation-v2",
    evaluator_id: evaluatorId,
    packet_path: packetSummary.packet_path,
    packet_id: packetSummary.packet_id,
    packet_digest: packetSummary.packet_digest,
    scores: packet.reports.map((report: any, reportIndex: number) => ({
      blinded_id: report.blinded_id,
      axes: Object.fromEntries(
        packet.axes.map((axis: string) => [
          axis,
          disagreements.axis &&
          reportIndex === 0 &&
          axis === "structural_recall"
            ? 0.7
            : 0.8,
        ]),
      ),
      claims: fixtureClaims(packaged, report.blinded_id).map(
        ({ claim }: any, claimIndex: number) => ({
          ...claim,
          support:
            disagreements.claim && reportIndex === 0 && claimIndex === 0
              ? "partial"
              : claim.support,
        }),
      ),
    })),
  };
}

function scoreInput(packaged: any, secondDisagreements: Disagreements = {}) {
  const evaluations = [
    evaluation(packaged, 0, "reviewer-1"),
    evaluation(packaged, 1, "reviewer-2", secondDisagreements),
  ];
  const packet = readJson(packaged.packets[0].packet_path);
  const claimResolutions = packet.reports.flatMap((report: any) => {
    const fixtures = fixtureClaims(packaged, report.blinded_id);
    const rows = evaluations.map((result: any) =>
      result.scores.find((row: any) => row.blinded_id === report.blinded_id),
    );
    const count = Math.max(...rows.map((row: any) => row.claims.length));
    return Array.from({ length: count }, (_, claimIndex) => {
      const observed = rows
        .map((row: any, evaluatorIndex: number) => ({
          claim: row.claims[claimIndex],
          evaluator_slot: evaluatorIndex + 1,
        }))
        .filter((item: any) => item.claim);
      const canonical = observed[0].claim;
      return {
        blinded_id: report.blinded_id,
        claim_refs: observed.map((item: any) => ({
          evaluator_slot: item.evaluator_slot,
          claim_index: claimIndex,
        })),
        normalized_finding_text: canonical.normalized_finding_text,
        treatment: canonical.treatment,
        support: canonical.support,
        confidence: canonical.confidence,
        private_id: fixtures[claimIndex]?.private_id ?? null,
        rationale: "Private adjudicator mapped the arm-blind claim to runtime gold.",
      };
    });
  });
  return {
    private_provenance_path: packaged.private_provenance_path,
    evaluator_input: {
      protocol: "p0-independent-evaluations-v2",
      evaluations,
    },
    adjudication: {
      protocol: "p0-private-adjudication-v2",
      adjudicator_id: "reviewer-3",
      packet_digests: packaged.packets.map((item: any) => item.packet_digest),
      resolutions: [] as Array<Record<string, unknown>>,
      claim_resolutions: claimResolutions,
    },
  };
}

function writeScore(state: ReturnType<typeof fixture>, name: string, input: unknown) {
  const path = join(state.root, `${name}.json`);
  writeJson(path, input);
  return path;
}

function replacePacket(
  state: ReturnType<typeof fixture>,
  input: any,
  evaluationIndex: number,
  name: string,
  mutate: (packet: any) => void,
) {
  const result = input.evaluator_input.evaluations[evaluationIndex];
  const packet = readJson(result.packet_path);
  mutate(packet);
  const { packet_digest: _oldDigest, ...content } = packet;
  packet.packet_digest = digest(content);
  const path = join(state.root, `${name}.packet.json`);
  writeJson(path, packet);
  result.packet_path = path;
  result.packet_id = packet.packet_id;
  result.packet_digest = packet.packet_digest;
  input.adjudication.packet_digests[evaluationIndex] = packet.packet_digest;
}

function setGroupInferior(
  input: any,
  state: ReturnType<typeof fixture>,
  packaged: any,
  group: "primary" | "held-out",
) {
  const provenance = readJson(packaged.private_provenance_path);
  const blindByRequest = new Map(
    provenance.report_bindings.map((binding: any) => [
      binding.request_id,
      binding.blinded_id,
    ]),
  );
  for (const pair of [
    ...state.manifest.primary.pairs,
    ...state.manifest.held_out.pairs,
  ]) {
    if (!pair.id.startsWith(`${group}-`)) continue;
    for (const arm of ["A", "B"] as const) {
      const blindedId = blindByRequest.get(`${pair.id}-${arm}`);
      const kind = state.identity.arms[pair.id][arm];
      for (const result of input.evaluator_input.evaluations) {
        const row = result.scores.find(
          (candidate: any) => candidate.blinded_id === blindedId,
        );
        for (const axis of state.manifest.axes)
          row.axes[axis] = kind === "candidate" ? 0 : 1;
      }
    }
  }
}

function candidateHeldBlindIds(state: ReturnType<typeof fixture>, packaged: any) {
  const provenance = readJson(packaged.private_provenance_path);
  const blindByRequest = new Map(
    provenance.report_bindings.map((binding: any) => [
      binding.request_id,
      binding.blinded_id,
    ]),
  );
  return state.manifest.held_out.pairs.map((pair: any) => {
    const arm = (["A", "B"] as const).find(
      (candidate) => state.identity.arms[pair.id][candidate] === "candidate",
    )!;
    return blindByRequest.get(`${pair.id}-${arm}`);
  });
}

function addUnmatchedCandidateClaims(
  state: ReturnType<typeof fixture>,
  packaged: any,
  input: any,
) {
  for (const blindedId of candidateHeldBlindIds(state, packaged)) {
    const refs = [];
    let claimIndex = -1;
    for (const [evaluationIndex, result] of input.evaluator_input.evaluations.entries()) {
      const row = result.scores.find(
        (candidate: any) => candidate.blinded_id === blindedId,
      );
      claimIndex = row.claims.length;
      row.claims.push({
        normalized_finding_text: "unmatched observed report relationship",
        treatment: "finding",
        support: "supported",
        confidence: 0.9,
        evidence: "Independent report evidence for an unmatched relationship",
      });
      refs.push({ evaluator_slot: evaluationIndex + 1, claim_index: claimIndex });
    }
    input.adjudication.claim_resolutions.push({
      blinded_id: blindedId,
      claim_refs: refs,
      normalized_finding_text: "unmatched observed report relationship",
      treatment: "finding",
      support: "supported",
      confidence: 0.9,
      private_id: null,
      rationale: "No runtime private-gold case matches this arm-blind claim.",
    });
  }
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
      expect(() => packageFixture(state)).toThrow(/raw|20|request/i);
    },
  );

  test.each([
    ["minimal record", (_state: any, raw: any) => {
      raw.records[0] = {
        request_id: raw.records[0].request_id,
        response: raw.records[0].response,
      };
    }],
    ["request digest", (_state: any, raw: any) => {
      raw.records[0].request_digest = "0".repeat(64);
    }],
    ["executor profile", (state: any, raw: any) => {
      const index = raw.records.findIndex((record: any) => {
        const request = state.requests.requests.find(
          (item: any) => item.request_id === record.request_id,
        );
        return state.identity.arms[request.pair_id][request.arm] === "control";
      });
      raw.records[index].response.pinned_profile.model = "tampered-model";
    }],
    ["candidate terminal", (state: any, raw: any) => {
      const index = raw.records.findIndex((record: any) => {
        const request = state.requests.requests.find(
          (item: any) => item.request_id === record.request_id,
        );
        return state.identity.arms[request.pair_id][request.arm] === "candidate";
      });
      raw.records[index].final_step.complete = false;
    }],
  ])("rejects %s provenance tampering", (_name, mutate) => {
    const state = fixture();
    const raw = readJson(state.rawPath);
    mutate(state, raw);
    writeJson(state.rawPath, raw);
    expect(() => packageFixture(state)).toThrow(/raw|provenance|binding|record/i);
  });

  test("keeps private provenance and gold outside the evaluator packet directory", () => {
    const state = fixture();
    const packetDirectory = join(state.root, "packets");
    for (const child of [
      join(packetDirectory, "provenance.private.json"),
      join(packetDirectory, "..private.json"),
      join(packetDirectory, "..private", "scoring.json"),
    ]) {
      expect(() =>
        packageEvaluators(
          state.manifestPath,
          state.rawPath,
          state.graphPath,
          state.identityPath,
          packetDirectory,
          child,
          state.goldPath,
        ),
      ).toThrow(/outside evaluator packet directory/i);
    }
    packageFixture(state);
    const insidePacket = join(packetDirectory, "gold.private.json");
    writeJson(insidePacket, state.gold);
    for (const goldPath of [state.manifestPath, insidePacket]) {
      expect(() =>
        packageEvaluators(
          state.manifestPath,
          state.rawPath,
          state.graphPath,
          state.identityPath,
          packetDirectory,
          join(state.root, `rejected-${basename(goldPath)}.json`),
          goldPath,
        ),
      ).toThrow(/gold.*outside.*repository.*packet/i);
    }
  });

  test("packages only generic report and claim instructions with exact packet bindings", () => {
    const state = fixture();
    const packaged = packageFixture(state);
    const provenance = readJson(packaged.private_provenance_path);
    expect(packaged.protocol).toBe("p0-evaluator-package-v2");
    expect(provenance.protocol).toBe("p0-private-scoring-provenance-v2");
    expect(provenance.gold_path).toBe(resolve(state.goldPath));
    expect(provenance.gold_digest).toBe(digest(state.gold));
    expect(provenance.packet_bindings).toEqual(
      packaged.packets.map((packet: any, index: number) => ({
        packet_id: packet.packet_id,
        evaluator_slot: index + 1,
        packet_path: resolve(packet.packet_path),
        packet_digest: packet.packet_digest,
      })),
    );
    expect(provenance.report_bindings.map((item: any) => item.request_id)).not.toEqual(
      state.records.map((item: any) => item.request_id),
    );
    for (const summary of packaged.packets) {
      const packet = readJson(summary.packet_path);
      const { packet_digest: packetDigest, ...content } = packet;
      expect(Object.keys(packet).sort()).toEqual([
        "axes",
        "axis_rubric",
        "claim_contract",
        "evaluator_slot",
        "manifest_digest",
        "packet_digest",
        "packet_id",
        "protocol",
        "reports",
      ]);
      expect(packet.protocol).toBe("p0-blinded-evaluator-packet-v2");
      expect(packet.reports).toHaveLength(20);
      expect(packet.claim_contract.fields).toEqual([
        "normalized_finding_text",
        "treatment",
        "support",
        "confidence",
        "evidence",
      ]);
      expect(Object.keys(packet.axis_rubric).sort()).toEqual(
        [...state.manifest.axes].sort(),
      );
      expect(packetDigest).toBe(digest(content));
      expect(summary.packet_digest).toBe(packetDigest);
      expect(packet).not.toHaveProperty("cases");
      const serialized = JSON.stringify(packet);
      expect(serialized).not.toMatch(/\b(?:control|candidate)\b/i);
      expect(serialized).not.toContain(state.goldPath);
      expect(serialized).not.toMatch(/case_id|private_id|strongest/i);
      expect(serialized).not.toMatch(/"(?:positive|negative|unscored)"/i);
      for (const item of state.gold.cases) {
        expect(serialized).not.toContain(item.private_id);
        expect(serialized).not.toContain(item.subject);
        expect(serialized).not.toContain(item.evidence_focus);
      }
      for (const report of packet.reports) {
        expect(Object.keys(report).sort()).toEqual([
          "blinded_id",
          "report",
          "report_sha256",
        ]);
        expect(report.report).toMatch(/^reports\/R-\d{2}\.md$/);
        expect(isAbsolute(report.report)).toBe(false);
        expect(existsSync(resolve(state.root, "packets", report.report))).toBe(
          true,
        );
      }
    }
    expect(new Set(packaged.packets.map((packet: any) => packet.packet_id)).size).toBe(2);
  });

  test("evaluator packets are byte-independent from arbitrary private-gold descriptions", () => {
    const state = fixture();
    const first = packageFixture(state);
    const firstPackets = first.packets.map((packet: any) => readJson(packet.packet_path));
    const phrases = [
      "Known defect behavior item",
      "Benign behavior reference item",
      "Placeholder item reference",
    ];
    state.gold.cases.forEach((item: any, index: number) => {
      item.subject = `${phrases[index % phrases.length]} ${index + 1}`;
      item.evidence_focus =
        `Arbitrary private operator wording ${index + 1} that must never influence evaluator packet bytes.`;
    });
    writeJson(state.goldPath, state.gold);
    const second = packageEvaluators(
      state.manifestPath,
      state.rawPath,
      state.graphPath,
      state.identityPath,
      join(state.root, "packets-second"),
      join(state.root, "provenance-second.private.json"),
      state.goldPath,
    );
    const secondPackets = second.packets.map((packet: any) =>
      readJson(packet.packet_path),
    );
    expect(secondPackets).toEqual(firstPackets);
    for (const packet of secondPackets)
      expect(JSON.stringify(packet)).not.toMatch(
        /known defect|benign behavior|placeholder item|case_id/i,
      );
  });

  test("rejects packet, slot, evaluator, and generic-claim shape tampering", () => {
    const state = fixture();
    const packaged = packageFixture(state);

    const injected = scoreInput(packaged);
    replacePacket(state, injected, 0, "injected-cases", (packet) => {
      packet.cases = [{ private_id: "leak" }];
    });
    expect(() => score(writeScore(state, "injected-cases", injected))).toThrow(
      /valid blinded packet/i,
    );

    const duplicateSlot = scoreInput(packaged);
    replacePacket(state, duplicateSlot, 1, "duplicate-slot", (packet) => {
      packet.evaluator_slot = 1;
    });
    expect(() => score(writeScore(state, "duplicate-slot", duplicateSlot))).toThrow(
      /independent|slot|packet/i,
    );

    const reusedEvaluator = scoreInput(packaged);
    reusedEvaluator.evaluator_input.evaluations[1].evaluator_id = " REVIEWER-1 ";
    expect(() => score(writeScore(state, "reused-evaluator", reusedEvaluator))).toThrow(
      /independent/i,
    );

    const malformedClaim = scoreInput(packaged);
    malformedClaim.evaluator_input.evaluations[0].scores[0].claims[0]
      .normalized_finding_text = "NOT NORMALIZED";
    expect(() => score(writeScore(state, "malformed-claim", malformedClaim))).toThrow(
      /generic claim|evaluator/i,
    );

    const rowInjection = scoreInput(packaged);
    rowInjection.evaluator_input.evaluations[0].scores[0].case_assessments = {};
    expect(() => score(writeScore(state, "row-injection", rowInjection))).toThrow(
      /generic claim|evaluator/i,
    );
  });

  test("privately resolves axis and claim disagreements without arm identity", () => {
    const state = fixture();
    const packaged = packageFixture(state);
    const input = scoreInput(packaged, { axis: true, claim: true });
    const packet = readJson(packaged.packets[0].packet_path);
    input.adjudication.resolutions = [
      {
        disagreement_id: `${packet.reports[0].blinded_id}:structural_recall`,
        value: 0.8,
        rationale: "Independent evidence review",
      },
    ];
    expect(score(writeScore(state, "resolved", input))).toMatchObject({
      protocol: "p0-derived-score-v2",
      accepted: true,
      aggregate: {
        primary: { ties_or_wins: 5, candidate_runs_recovering_strongest: 5 },
        held_out: { ties_or_wins: 5 },
      },
    });
    expect(JSON.stringify(input.adjudication)).not.toMatch(
      /\b(?:control|candidate)\b/i,
    );

    const missing = scoreInput(packaged, { axis: true });
    expect(() => score(writeScore(state, "axis-missing", missing))).toThrow(
      /axis disagreements/i,
    );
  });

  test("rejects fabricated, incomplete, duplicate, or cross-group claim mappings", () => {
    const state = fixture();
    const packaged = packageFixture(state);
    const baseline = scoreInput(packaged);
    expect(score(writeScore(state, "baseline", baseline))).toMatchObject({
      accepted: true,
    });
    const { provenance, gold } = privateContext(packaged);
    const primaryBlind = provenance.report_bindings.find(
      (binding: any) => binding.gold_group === "primary",
    ).blinded_id;
    const heldPrivateId = gold.cases.find(
      (item: any) => item.group === "held_out",
    ).private_id;
    const primaryResolutionIndex = baseline.adjudication.claim_resolutions.findIndex(
      (item: any) => item.blinded_id === primaryBlind,
    );
    const invalid: Array<[string, (copy: any) => void]> = [
      ["unknown private id", (copy) => {
        copy.adjudication.claim_resolutions[0].private_id = "fabricated-private-id";
      }],
      ["fabricated canonical text", (copy) => {
        copy.adjudication.claim_resolutions[0].normalized_finding_text =
          "fabricated canonical text";
      }],
      ["missing mapping", (copy) => {
        copy.adjudication.claim_resolutions.pop();
      }],
      ["duplicate reference", (copy) => {
        copy.adjudication.claim_resolutions[1].claim_refs.push(
          structuredClone(copy.adjudication.claim_resolutions[0].claim_refs[0]),
        );
        copy.adjudication.claim_resolutions[1].blinded_id =
          copy.adjudication.claim_resolutions[0].blinded_id;
      }],
      ["caller outcome", (copy) => {
        copy.adjudication.claim_resolutions[0].outcome = "recovered";
      }],
      ["cross group", (copy) => {
        copy.adjudication.claim_resolutions[primaryResolutionIndex].private_id =
          heldPrivateId;
      }],
      ["arm leak", (copy) => {
        copy.adjudication.claim_resolutions[0].rationale =
          "candidate arm should receive this mapping";
      }],
    ];
    for (const [name, mutate] of invalid) {
      const copy = structuredClone(baseline);
      mutate(copy);
      expect(() => score(writeScore(state, name.replaceAll(" ", "-"), copy)), name)
        .toThrow();
    }
  });

  test("rejects canonical claim tuples spliced from different referenced claims", () => {
    const state = fixture();
    const packaged = packageFixture(state);
    const input = scoreInput(packaged);
    const [first, second] = input.adjudication.claim_resolutions.filter(
      (item: any) =>
        item.blinded_id ===
        input.adjudication.claim_resolutions[0].blinded_id,
    );
    const firstSlotOne = first.claim_refs.find(
      (reference: any) => reference.evaluator_slot === 1,
    );
    const firstSlotTwo = first.claim_refs.find(
      (reference: any) => reference.evaluator_slot === 2,
    );
    const secondSlotOne = second.claim_refs.find(
      (reference: any) => reference.evaluator_slot === 1,
    );
    const secondSlotTwo = second.claim_refs.find(
      (reference: any) => reference.evaluator_slot === 2,
    );
    first.claim_refs = [firstSlotOne, secondSlotTwo];
    second.claim_refs = [secondSlotOne, firstSlotTwo];

    const secondEvaluator = input.evaluator_input.evaluations[1];
    const secondRow = secondEvaluator.scores.find(
      (row: any) => row.blinded_id === first.blinded_id,
    );
    const contrastingClaim = secondRow.claims[secondSlotTwo.claim_index];
    contrastingClaim.treatment = "validly_subsumed";
    contrastingClaim.support = "partial";
    contrastingClaim.confidence = 0.7;

    first.treatment = contrastingClaim.treatment;
    first.confidence = contrastingClaim.confidence;
    expect(() => score(writeScore(state, "spliced-tuple", input))).toThrow(
      /cannot fabricate canonical claim values/i,
    );
  });

  test("unmatched and negative-case finding claims are derived as false positives", () => {
    const state = fixture();
    const packaged = packageFixture(state);

    const unmatched = scoreInput(packaged);
    addUnmatchedCandidateClaims(state, packaged, unmatched);
    expect(() => score(writeScore(state, "unmatched", unmatched))).toThrow(
      /derived benchmark score/i,
    );

    const negative = scoreInput(packaged);
    const { gold } = privateContext(packaged);
    const negativeIds = new Set(
      gold.cases
        .filter((item: any) => item.group === "held_out" && item.sign === "negative")
        .map((item: any) => item.private_id),
    );
    for (const blindedId of candidateHeldBlindIds(state, packaged)) {
      const resolutions = negative.adjudication.claim_resolutions.filter(
        (item: any) =>
          item.blinded_id === blindedId && negativeIds.has(item.private_id),
      );
      for (const resolution of resolutions) {
        resolution.treatment = "finding";
        for (const reference of resolution.claim_refs) {
          const result = negative.evaluator_input.evaluations[reference.evaluator_slot - 1];
          const row = result.scores.find(
            (candidate: any) => candidate.blinded_id === blindedId,
          );
          row.claims[reference.claim_index].treatment = "finding";
        }
      }
    }
    expect(() => score(writeScore(state, "negative-fp", negative))).toThrow(
      /derived benchmark score/i,
    );
  });

  test("high-confidence unsupported findings are derived from claim mappings", () => {
    const state = fixture();
    const packaged = packageFixture(state);
    const input = scoreInput(packaged);
    const blindedId = candidateHeldBlindIds(state, packaged)[0];
    const { gold } = privateContext(packaged);
    const positiveIds = new Set(
      gold.cases
        .filter(
          (item: any) =>
            item.group === "held_out" && item.sign === "positive",
        )
        .map((item: any) => item.private_id),
    );
    const resolution = input.adjudication.claim_resolutions.find(
      (item: any) =>
        item.blinded_id === blindedId && positiveIds.has(item.private_id),
    );
    resolution.support = "unsupported";
    for (const reference of resolution.claim_refs) {
      const result =
        input.evaluator_input.evaluations[reference.evaluator_slot - 1];
      const row = result.scores.find(
        (candidate: any) => candidate.blinded_id === blindedId,
      );
      row.claims[reference.claim_index].support = "unsupported";
    }
    expect(() => score(writeScore(state, "unsupported", input))).toThrow(
      /derived benchmark score/i,
    );
  });

  test.each([
    ["primary", "held-out"],
    ["held-out", "primary"],
  ] as const)(
    "rejects when %s passes but %s independently fails",
    (_passingGroup, failingGroup) => {
      const state = fixture();
      const packaged = packageFixture(state);
      const input = scoreInput(packaged);
      setGroupInferior(input, state, packaged, failingGroup);
      expect(() => score(writeScore(state, `${failingGroup}-inferior`, input))).toThrow(
        /derived benchmark score/i,
      );
    },
  );

  test("revalidates source reports, blinded copies, packets, gold, and provenance", () => {
    const state = fixture();
    const packaged = packageFixture(state);
    const input = scoreInput(packaged);
    expect(score(writeScore(state, "baseline-integrity", input))).toMatchObject({
      accepted: true,
    });

    const provenance = readJson(packaged.private_provenance_path);
    const copyPath = provenance.report_bindings[0].packet_report_path;
    const sourcePath = provenance.report_bindings[0].source_report_path;
    const original = readFileSync(sourcePath);
    writeFileSync(copyPath, "tampered blinded copy\n");
    expect(() => score(writeScore(state, "tampered-copy", input))).toThrow();
    writeFileSync(copyPath, original);
    writeFileSync(sourcePath, "tampered source report\n");
    expect(() => score(writeScore(state, "tampered-source", input))).toThrow();
    writeFileSync(sourcePath, original);

    const tampered = readJson(packaged.private_provenance_path);
    tampered.report_bindings[0].gold_group =
      tampered.report_bindings[0].gold_group === "primary" ? "held_out" : "primary";
    const { provenance_digest: _oldDigest, ...content } = tampered;
    tampered.provenance_digest = digest(content);
    const tamperedPath = join(state.root, "tampered-provenance.private.json");
    writeJson(tamperedPath, tampered);
    const provenanceInput = structuredClone(input);
    provenanceInput.private_provenance_path = tamperedPath;
    expect(() => score(writeScore(state, "tampered-provenance", provenanceInput))).toThrow(
      /provenance does not bind/i,
    );

    const originalGold = readJson(state.goldPath);
    originalGold.cases[0].sign = "unscored";
    writeJson(state.goldPath, originalGold);
    expect(() => score(writeScore(state, "tampered-gold", input))).toThrow();
  });
});
