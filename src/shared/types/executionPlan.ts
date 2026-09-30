// sites-pinned: tests/shared/contractPipeline-types.test.ts, tests/shared/shared-core-invariants.test.ts, tests/remediate/executable-plan-identity.test.ts
import { z } from "zod";

const text = z.string().trim().min(1);
const id = text.regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u);

/** Stable requirement identities are authored once, not derived from array position. */
export const ExecutionRequirementSchema = z.object({
  id,
  description: text,
  source_finding_ids: z.array(text),
  change_kind: z.enum(["behavior_change", "addition", "structural"]),
  assertions: z.array(z.object({
    kind: z.enum(["positive", "negative"]),
    description: text,
    scope_paths: z.array(text).min(1),
  }).strict()),
  inapplicable_reason: text.optional(),
}).strict().superRefine((requirement, ctx) => {
  if (requirement.inapplicable_reason) {
    if (requirement.assertions.length) ctx.addIssue({ code: "custom", message: "An inapplicability claim cannot also claim assertions." });
    return;
  }
  const kinds = new Set(requirement.assertions.map(assertion => assertion.kind));
  if (requirement.change_kind === "behavior_change" && (!kinds.has("positive") || !kinds.has("negative"))) {
    ctx.addIssue({ code: "custom", message: "A behavior change needs scoped positive and negative assertions." });
  }
  if (requirement.change_kind === "addition" && !requirement.assertions.length) {
    ctx.addIssue({ code: "custom", message: "An addition needs a falsifiable assertion." });
  }
});
export type ExecutionRequirement = z.infer<typeof ExecutionRequirementSchema>;

/** The reviewed unit IS the implementation assignment; there is no later semantic planner. */
export const ExecutionUnitSchema = z.object({
  id,
  title: text,
  description: text,
  source_finding_ids: z.array(text),
  requirement_ids: z.array(id).min(1),
  dependencies: z.array(id),
  /** Explicit reviewed integration checkpoint; absent means dependency-only execution. */
  phase_ordinal: z.number().int().nonnegative().optional(),
  read_paths: z.array(text).min(1),
  allowed_files: z.array(text),
  required_tests: z.array(text),
  affected_interfaces: z.array(z.object({ name: text, description: text }).strict()).default([]),
  addresses_counterexample_ids: z.array(id),
}).strict();
export type ExecutionUnit = z.infer<typeof ExecutionUnitSchema>;

export const ExecutionRequestSchema = z.object({ id, text, source_paths: z.array(text) }).strict();
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const ExecutionSourceDispositionSchema = z.object({
  finding_id: text,
  status: z.enum(["already_fixed", "refuted", "deferred"]),
  reason: text,
  evidence: z.array(text).min(1),
}).strict();
export type ExecutionSourceDisposition = z.infer<typeof ExecutionSourceDispositionSchema>;
export const ExecutionRequestDispositionSchema = z.object({
  status: z.enum(["already_satisfied", "deferred"]), reason: text, evidence: z.array(text).min(1),
}).strict();

/** Semantic authoring surface. Source provenance and accepted review receipts are tool-owned. */
export const ExecutableChangePlanSchema = z.object({
  plan_id: id,
  objective: text,
  non_goals: z.array(text),
  requirements: z.array(ExecutionRequirementSchema),
  units: z.array(ExecutionUnitSchema),
  source_dispositions: z.array(ExecutionSourceDispositionSchema).default([]),
  request_disposition: ExecutionRequestDispositionSchema.optional(),
}).strict();
export type ExecutableChangePlan = z.infer<typeof ExecutableChangePlanSchema>;

/** Pure graph/provenance constraints shared by authoring, persisted state and handoff. */
export function executionPlanReferenceIssues(
  plan: ExecutableChangePlan,
  sourceFindingIds: readonly string[],
): string[] {
  const issues: string[] = [];
  const sources = new Set(sourceFindingIds);
  const requirements = new Set(plan.requirements.map(requirement => requirement.id));
  const units = new Set(plan.units.map(unit => unit.id));
  const unique = (values: readonly string[], label: string): void => {
    if (new Set(values).size !== values.length) issues.push(`${label} must be unique.`);
  };
  unique(sourceFindingIds, "Source finding IDs");
  unique(plan.requirements.map(requirement => requirement.id), "Requirement IDs");
  unique(plan.units.map(unit => unit.id), "Execution unit IDs");
  for (const requirement of plan.requirements) {
    unique(requirement.source_finding_ids, `Requirement ${requirement.id} source references`);
    for (const id of requirement.source_finding_ids) if (!sources.has(id)) issues.push(`Requirement ${requirement.id} references unknown source finding ${id}.`);
    if (!plan.units.some(unit => unit.requirement_ids.includes(requirement.id))) issues.push(`Requirement ${requirement.id} has no execution unit.`);
  }
  for (const unit of plan.units) {
    unique(unit.source_finding_ids, `Unit ${unit.id} source references`);
    unique(unit.requirement_ids, `Unit ${unit.id} requirement references`);
    unique(unit.dependencies, `Unit ${unit.id} dependencies`);
    unique(unit.addresses_counterexample_ids, `Unit ${unit.id} counterexample references`);
    for (const id of unit.source_finding_ids) if (!sources.has(id)) issues.push(`Unit ${unit.id} references unknown source finding ${id}.`);
    for (const id of unit.requirement_ids) if (!requirements.has(id)) issues.push(`Unit ${unit.id} references unknown requirement ${id}.`);
    for (const id of unit.dependencies) if (!units.has(id) || id === unit.id) issues.push(`Unit ${unit.id} has an invalid dependency ${id}.`);
    const requiredSources = plan.requirements.filter(requirement => unit.requirement_ids.includes(requirement.id)).flatMap(requirement => requirement.source_finding_ids);
    for (const id of new Set(requiredSources)) if (!unit.source_finding_ids.includes(id)) issues.push(`Unit ${unit.id} drops requirement source finding ${id}.`);
  }
  unique(plan.source_dispositions.map(disposition => disposition.finding_id), "Source dispositions");
  for (const disposition of plan.source_dispositions) {
    if (!sources.has(disposition.finding_id)) issues.push(`Disposition references unknown finding ${disposition.finding_id}.`);
    if (plan.units.some(unit => unit.source_finding_ids.includes(disposition.finding_id))) issues.push(`Source finding ${disposition.finding_id} has both execution units and a disposition.`);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { issues.push(`Execution dependency cycle at ${id}.`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of plan.units.find(unit => unit.id === id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of units) visit(id);
  return issues;
}
