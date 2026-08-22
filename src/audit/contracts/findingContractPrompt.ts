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

import { zodToJsonSchema } from "zod-to-json-schema";
import {
  CONFIDENCES,
  LENSES,
  SEVERITIES,
  FINDING_LINE_END_INTEGER_RULE,
  FINDING_LINE_ORDER_RULE,
  FINDING_LINE_START_INTEGER_RULE,
} from "audit-tools/shared";
import { AUDIT_RESULT_RULES } from "../validation/auditResults.js";
import { WorkerFindingSchema } from "./workerSchemas.js";

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

let renderedContract: readonly string[] | undefined;

/**
 * The finding contract as prompt lines: required fields (with their shapes),
 * min-length facts, the closed vocabularies, the optional fields with their own
 * `.describe()` text, and every non-schema rule statement verbatim.
 *
 * Memoized: the derivation is pure and the result is embedded in every
 * work-item prompt (and therefore in every prompt hash), so it must be both
 * cheap and byte-stable across a run.
 */
export function findingContractPromptLines(): readonly string[] {
  if (renderedContract !== undefined) return renderedContract;
  const schema = zodToJsonSchema(WorkerFindingSchema, {
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
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
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
  const nonEmptyLine = (names: readonly string[]): string =>
    `Finding contract — ${names.join(", ")} ` +
    `${names.every((name) => required.includes(name)) ? "must be non-empty" : "must be non-empty when supplied"} ` +
    "(an empty value rejects the submission).";
  const lines: string[] = [
    "Finding contract — every entry of `findings` must carry these required fields: " +
      required
        .map((name) => `${name} (${describeField(properties[name])})`)
        .join(", ") +
      ".",
    ...[
      nonEmptyFields.filter((name) => required.includes(name)),
      nonEmptyFields.filter((name) => !required.includes(name)),
    ]
      .filter((names) => names.length > 0)
      .map((names) => nonEmptyLine(names)),
    "These fields are JSON arrays whenever present, never a bare string or object: " +
      arrayFields.join(", ") +
      ". A finding that fails this contract rejects the whole submission.",
    `Closed vocabularies — severity must be one of ${SEVERITIES.join("|")}; confidence one of ${CONFIDENCES.join("|")}; lens one of ${LENSES.join("|")}.`,
    ...optionalFields
      .filter(([, node]) => typeof node.description === "string")
      .map(
        ([name, node]) =>
          `${name} is optional${typeof node.description === "string" ? `: ${node.description}` : "."}`,
      ),
    // The line-span rules are enforced by the shared location refinement; the
    // prompt states the very sentences the refinement emits (the exported
    // constants), so the check and the statement cannot drift.
    `Rule: ${FINDING_LINE_START_INTEGER_RULE}`,
    `Rule: ${FINDING_LINE_END_INTEGER_RULE}`,
    `Rule: ${FINDING_LINE_ORDER_RULE}`,
    // Every cross-record rule the downstream validator enforces, verbatim from
    // the registry the validator itself reads — not a paraphrase.
    ...AUDIT_RESULT_RULES.map((rule) => `Rule: ${rule.statement}`),
  ];
  renderedContract = lines;
  return renderedContract;
}
