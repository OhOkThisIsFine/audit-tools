// The audit draw's finding contract as prompt lines.
//
// DERIVED from `WorkerFindingSchema` — the strict projection ingestion parses —
// plus `AUDIT_RESULT_RULES`, the registry of the rules that are not expressible
// as per-finding schema refinements and that `validateAuditResults` emits its
// messages FROM. Prompt, acceptance and validation therefore share ONE source:
// a field or rule the validators enforce is stated here because it exists in
// the schema/registry, never because someone remembered to copy it in.
//
// A dispatch prompt that says only "findings must satisfy the audit finding
// contract" leaves the host to remember or fetch the contract; a measured lap
// lost four complete results exactly that way (findings missing the required
// per-finding `lens`; `evidence` submitted as a string where an array is
// required), and the 2026-08-21 lap then lost more to `evidence` being omitted
// entirely while downstream validation required it.

// sites-pinned: tests/audit/host-result-finding-contract.test.ts, tests/audit/host-ingest-grounding.test.ts
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AUDIT_FINDING_QUOTE_OR_DECLARATION_RULE,
  CONFIDENCES,
  SEVERITIES,
  compareCodeUnits,
} from "audit-tools/shared";
import { AUDIT_RESULT_RULES } from "../validation/auditResults.js";
import {
  WORKER_REFUSED_LOCATION_FIELDS,
  WorkerFindingSchema,
} from "./workerSchemas.js";

/** The JSON-Schema shape this renderer reads. Narrow by design — nothing else is consulted. */
interface SchemaNode {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  /** Emitted for a `.min(n)` array; >= 1 means "non-empty when supplied". */
  minItems?: number;
  /** Emitted for a `.min(n)` string; >= 1 means "non-empty when supplied". */
  minLength?: number;
}

function describeField(node: SchemaNode | undefined): string {
  if (node === undefined) return "value";
  if (Array.isArray(node.enum)) {
    return `one of ${node.enum.map((value) => String(value)).join("|")}`;
  }
  if (node.type === "array") {
    const item = node.items;
    if (item?.type === "object") {
      const required = [...(item.required ?? [])].sort();
      return required.length > 0
        ? `array of objects, each requiring ${required.join(" + ")}`
        : "array of objects";
    }
    return typeof item?.type === "string" ? `array of ${item.type}s` : "array";
  }
  return typeof node.type === "string" ? node.type : "value";
}

/**
 * The finding schema the prompt describes: the worker schema less two optional
 * fields, each omitted for its own reason. The prompt-contract registry checks
 * the prompt against THIS object, so the omission is one statement, not two.
 * - `lens`: the `finding_lens_matches_task` rule states it whole (cut C7).
 * - `analyzer_provenance`: the field is copied from an injected lead's
 *   provenance object, and no work-item prompt delivers one (cut C5; the
 *   missing injection is D15 of the 2026-11-06 dogfood audit). Asking every
 *   reader for it asks for a value it cannot have.
 */
// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts, tests/audit/finding-contract-vocab-line.test.ts
export const PROMPTED_FINDING_SCHEMA = WorkerFindingSchema.omit({ lens: true, analyzer_provenance: true });

let renderedContract: readonly string[] | undefined;

/**
 * The finding contract as prompt lines: required fields (with their shapes),
 * min-length facts, the closed vocabularies, the optional fields with their own
 * `.describe()` text, and every worker-owned non-schema rule statement verbatim.
 *
 * Memoized: the derivation is pure and the result is embedded in every
 * work-item prompt (and therefore in every prompt hash), so it must be both
 * cheap and byte-stable across a run.
 */
export function findingContractPromptLines(): readonly string[] {
  if (renderedContract !== undefined) return renderedContract;
  const schema = zodToJsonSchema(PROMPTED_FINDING_SCHEMA, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as SchemaNode;
  const properties = schema.properties ?? {};
  const required = [...(schema.required ?? [])].sort();
  const arrayFields = Object.entries(properties)
    .filter(([, node]) => node.type === "array")
    .map(([name]) => name)
    .sort();
  const optionalFields = Object.entries(properties)
    .filter(([name]) => !required.includes(name))
    .sort(([left], [right]) => compareCodeUnits(left, right));
  // Every min(1) the schema carries is a contract fact the host must know —
  // an empty value fails the parse exactly as a missing field does — so it is
  // detected FROM the schema node (required or optional, array or string),
  // never from a hand list.
  const nonEmptyFields = Object.entries(properties)
    .filter(
      ([, node]) => (node.minItems ?? 0) >= 1 || (node.minLength ?? 0) >= 1,
    )
    .map(([name]) => name)
    .sort();
  // ONE non-empty line (decision 5, cut C7): the required fields, then the
  // optional ones "when supplied". The whole-rejection consequence is stated
  // once, at the end of the work-item prompt, not on each line.
  const requiredNonEmpty = nonEmptyFields.filter((name) => required.includes(name));
  const optionalNonEmpty = nonEmptyFields.filter((name) => !required.includes(name));
  const nonEmptyClauses = [
    ...(requiredNonEmpty.length > 0 ? [requiredNonEmpty.join(", ")] : []),
    ...(optionalNonEmpty.length > 0 ? [`when supplied: ${optionalNonEmpty.join(", ")}`] : []),
  ];
  const lines: string[] = [
    "Finding contract — every entry of `findings` must carry these required fields: " +
      required
        .map((name) => `${name} (${describeField(properties[name])})`)
        .join(", ") +
      ".",
    ...(nonEmptyClauses.length > 0 ? [`Must be non-empty: ${nonEmptyClauses.join("; ")}.`] : []),
    "JSON arrays when present, never a bare string or object: " + arrayFields.join(", ") + ".",
    // Severity and confidence are required on every finding. The lens has no
    // vocabulary clause: the lens rule below ("match the assigned task lens, or
    // omit it") leaves exactly one valid value, so a list of eleven would only
    // invite a wrong one (cut C7). Still derived: the lists come from the
    // shared vocabularies, never a hand-typed copy.
    `Closed vocabularies — severity must be one of ${SEVERITIES.join("|")}; confidence one of ${CONFIDENCES.join("|")}.`,
    ...optionalFields
      .filter(([, node]) => typeof node.description === "string")
      .map(
        ([name, node]) =>
          `${name} is optional${typeof node.description === "string" ? `: ${node.description}` : "."}`,
      ),
    // The grounding ask. It was missing entirely: `quoted_text` was named once,
    // and only as text the tool re-reads, so a reader who obeyed the prompt
    // exactly shipped no quote and every finding grounded `ungrounded`. The
    // sentence is the constant both doors refuse with.
    `Rule: ${AUDIT_FINDING_QUOTE_OR_DECLARATION_RULE}`,
    // Line numbers are tool-owned (`WORKER_REFUSED_LOCATION_FIELDS`): the
    // reviewer cites CODE, and the quote must name one place for the tool to
    // derive the span from.
    `Rule: affected_files entries never carry ${Object.keys(WORKER_REFUSED_LOCATION_FIELDS).join(" or ")} — ` +
      "the tool derives them from where quoted_text occurs. Quote a span that occurs exactly once " +
      "in its file: a quote that occurs more than once, or not at all, leaves the finding ungrounded.",
    // Ingest derives the clean-result affirmation, and the coverage span holds
    // by construction once the tool writes the lines. Only worker-owned rules
    // belong in this prompt.
    ...AUDIT_RESULT_RULES
      .filter(
        (rule) =>
          rule.id !== "reviewed_clean_affirmation" &&
          rule.id !== "affected_span_within_coverage",
      )
      .map((rule) => `Rule: ${rule.statement}`),
  ];
  renderedContract = lines;
  return renderedContract;
}
