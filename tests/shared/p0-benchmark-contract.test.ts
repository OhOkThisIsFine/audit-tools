import { expect, test } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

test("P0 checked-in benchmark inputs contain no public scoring gold", () => {
  const manifest = json("benchmarks/p0/manifest.json");
  expect(manifest.primary).not.toHaveProperty("accepted_reports");
  expect(manifest.primary).not.toHaveProperty("normalized_opportunity_ids");
  expect(manifest.primary).not.toHaveProperty("strongest_opportunity_ids");
  expect(manifest.held_out).not.toHaveProperty("seeded_positive_classes");
  expect(manifest.held_out).not.toHaveProperty("negative_controls");
  expect(manifest.held_out.corpus).not.toHaveProperty("labels_path");
  expect(manifest.held_out.corpus).not.toHaveProperty("labels_outside_root");
  expect(
    existsSync(resolve(root, "benchmarks/p0/corpus/primary-opportunities.json")),
  ).toBe(false);
  expect(
    existsSync(resolve(root, "benchmarks/p0/corpus/held-out/labels.json")),
  ).toBe(false);
  expect(
    statSync(resolve(root, "benchmarks/p0/held-out-corpus")).isDirectory(),
  ).toBe(true);
});

test("P0 score schema uses exact private-gold scoring contract", () => {
  const schema = json("benchmarks/p0/score-schema.json");
  expect(schema.protocol).toBe("p0-score-v2");
  expect(schema.outcomes).toEqual({ recovered: 1, validly_subsumed: 1, partial: 0.5, evidence_refuted: 1, missed: 0 });
  expect(schema.axes).toEqual(["structural_recall", "philosophy_telos_recall", "grounding_precision", "telos_to_code_linkage", "reduction_value", "false_positive_discipline"]);
  expect(schema.evaluation.row_fields).toEqual([
    "axes",
    "claims",
  ]);
  expect(schema.evaluation.public_randomization_seed).toBe(false);
  expect(schema.evaluation.packet_report_paths).toMatch(/blinded.*packet-local/i);
  expect(schema.evaluation.packet_protocol).toBe(
    "p0-blinded-evaluator-packet-v2",
  );
  expect(schema.evaluation.packet_content).toEqual([
    "generic axis rubric",
    "generic claim instructions",
    "blinded reports",
  ]);
  expect(schema.evaluation.evaluation_protocol).toBe(
    "p0-blinded-evaluation-v2",
  );
  expect(schema.evaluation.claim_fields).toEqual([
    "normalized_finding_text",
    "treatment",
    "support",
    "confidence",
    "evidence",
  ]);
  expect(schema.evaluation.claim_treatments).toEqual([
    "finding",
    "validly_subsumed",
    "explicitly_defended",
  ]);
  expect(schema.evaluation.claim_support_levels).toEqual([
    "supported",
    "partial",
    "unsupported",
  ]);
  expect(schema.evaluation).not.toHaveProperty("packet_case_ids");
  expect(schema.evaluation).not.toHaveProperty("case_treatments");
  expect(schema.derivation.private_provenance).toMatch(/private gold/i);
  expect(schema.derivation.private_provenance_protocol).toBe(
    "p0-private-scoring-provenance-v2",
  );
  expect(schema.derivation.adjudication_protocol).toBe(
    "p0-private-adjudication-v2",
  );
  expect(schema.derivation.claim_mapping).toMatch(/exactly once.*private-gold.*null/i);
  expect(schema.derivation.unmatched_false_positive_count).toMatch(/mapped to null/i);
  expect(schema.derivation.caller_supplied_aggregate).toBe("rejected");
  expect(schema.derivation.held_out_quality_floors).toEqual({
    candidate_axis_median_min: 0.6,
    candidate_positive_rate_min: 0.8,
    candidate_negative_false_positive_rate_max: 0.1,
  });
});

test("P0 private-gold schema publishes only the complete structural contract", () => {
  const manifest = json("benchmarks/p0/manifest.json");
  expect(manifest.evaluation.private_gold_schema).toBe(
    "benchmarks/p0/private-gold.schema.json",
  );
  const schema = json(manifest.evaluation.private_gold_schema);
  expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toEqual(["protocol", "manifest_digest", "cases"]);
  expect(schema.properties.protocol).toEqual({ const: "p0-private-gold-v1" });
  expect(schema.properties.manifest_digest).toMatchObject({
    type: "string",
    pattern: "^[0-9a-f]{64}$",
  });
  expect(schema.properties.cases).toMatchObject({
    type: "array",
    minItems: 8,
  });
  const item = schema.properties.cases.items;
  expect(item.additionalProperties).toBe(false);
  expect(item.required).toEqual([
    "private_id",
    "group",
    "subject",
    "evidence_focus",
    "sign",
    "strongest",
  ]);
  expect(item.properties.group.enum).toEqual(["primary", "held_out"]);
  expect(item.properties.sign.enum).toEqual([
    "positive",
    "negative",
    "unscored",
  ]);
  expect(item.properties.subject.minLength).toBe(16);
  expect(item.properties.evidence_focus.minLength).toBe(24);
  expect(schema.allOf).toHaveLength(6);
  expect(schema.allOf.map((rule: any) => rule.minContains)).toEqual([
    4,
    1,
    1,
    1,
    1,
    4,
  ]);
  expect(schema.allOf.at(-1).maxContains).toBe(4);
  const serialized = JSON.stringify(schema);
  expect(serialized).not.toMatch(/O-\d{2}|duplicated_machinery|goal_conflict/);
});
