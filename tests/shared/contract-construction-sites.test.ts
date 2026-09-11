/**
 * Per-type CONSTRUCTION-SITE derivation (`scripts/check-contract-sites.mjs`).
 *
 * The defect class this covers is in `docs/backlog/minor-bugs.md` (2026-07-25):
 * adding a field to `AuditResult` swept `tests/**`, missed the producers under
 * `scripts/`, and failed release CI — because the set of places that construct a
 * contract was answerable only by reading the TESTS, so it tracked where tests
 * live rather than where the contract is consumed.
 *
 * The property: for every validated contract type the set of construction sites
 * is derivable FROM THE CONTRACT, not from test placement.
 *
 * TWO KINDS OF ASSERTION HERE, and the split matters:
 *   • the WALKER is driven against fixture trees, so every refusal path is
 *     exercised without breaking the real repo;
 *   • the REGISTRY is driven against the REAL zod schemas, so the property
 *     shapes cannot drift from the schemas they describe. Without this half the
 *     registry would be a hand-maintained copy of `FindingSchema` that quietly
 *     stopped matching it — which is the failure the whole module exists to
 *     prevent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveConstructionSites,
  isProducerPath,
  parseSiteMarkers,
  reconcileRenderedSchema,
} from "../../src/shared/validation/contractConstructionSites.js";
import { CONTRACT_PROPERTY_SHAPES } from "../../src/shared/types/contractPropertyShapes.js";
import { FindingSchema } from "../../src/shared/types/finding.js";
import {
  CONTRACT_SCHEMA_PRODUCERS,
  WorkerAuditResultSchema,
} from "../../src/audit/contracts/workerSchemas.js";
import { AuditTaskSchema } from "../../src/audit/types.js";
import { FORBIDDEN_MARKER_FIELDS, reconcileContractSites } from "../../scripts/check-contract-sites.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("registry ↔ the real zod contracts (the drift half)", () => {
  const isOptional = (schema: { isOptional: () => boolean }) => schema.isOptional();

  // A CONTRACT type and the REAL schema its registry row describes. `AuditTask` is
  // here rather than skipped: `AuditTaskSchema` in src/audit/types.ts is the
  // canonical zero value type, and `WorkerAuditTaskSchema` (what the rendered
  // schema is generated from) is that schema EXTENDED — so the row is held against
  // the same base every worker task inherits. Returning early on a null schema
  // left the row pointing at an assertion that did not exist.
  const REAL_SCHEMAS: [string, { shape: Record<string, unknown> }][] = [
    ["Finding", FindingSchema],
    ["AuditResult", WorkerAuditResultSchema],
    ["AuditTask", AuditTaskSchema],
  ];

  it.each(REAL_SCHEMAS)(
    "the registry's %s row carries exactly the schema's own properties",
    (type, schema) => {
      const row = CONTRACT_PROPERTY_SHAPES.find((c) => c.type === type);
      expect(row, `no registry row for ${type}`).toBeDefined();
      expect(Object.keys(row!.properties).sort()).toEqual(Object.keys(schema.shape).sort());
    },
  );

  it("every registry row's optionality matches the real schema's, where one is resolvable", () => {
    // EVERY type with a real schema, not `Finding` alone: the optionality half is
    // the one a `z.infer` rewrite silently inverts (`x?: T` and `x: T.optional()`
    // read the same at a glance), and checking one row left the other two
    // unchecked while the test's name claimed the registry.
    for (const [type, schema] of REAL_SCHEMAS) {
      const row = CONTRACT_PROPERTY_SHAPES.find((c) => c.type === type)!;
      const shape = schema.shape as Record<string, { isOptional: () => boolean }>;
      for (const [key, property] of Object.entries(shape)) {
        const declared = row.properties[key]?.allowsUndefined ?? false;
        expect(
          declared,
          `${type}.${key}: registry says optional=${declared}, zod says ${isOptional(property)}`,
        ).toBe(isOptional(property));
      }
    }
  });

  it("every contract type named by a schema producer exists in the registry", () => {
    for (const [schemaFile, producer] of Object.entries(CONTRACT_SCHEMA_PRODUCERS)) {
      const found = CONTRACT_PROPERTY_SHAPES.some((c) => c.type === producer.contract);
      expect(found, `${schemaFile} names contract "${producer.contract}" with no registry row`).toBe(true);
    }
  });

  it("the registry has no duplicate type, and every row names a schema", () => {
    const types = CONTRACT_PROPERTY_SHAPES.map((c) => c.type);
    expect(new Set(types).size).toBe(types.length);
    for (const row of CONTRACT_PROPERTY_SHAPES) {
      expect(row.schema, `${row.type} names no schema`).toBeTruthy();
      expect(Object.keys(row.properties).length, `${row.type} declares no properties`).toBeGreaterThan(0);
    }
  });
});

describe("producer classification", () => {
  it.each([
    ["scripts/check-contract-sites.mjs", true],
    ["scripts/shared/derived-file-preflight.mjs", true],
    ["src/audit/cli/dispatch/hostHandoff.ts", true],
    ["audit-code.mjs", true],
    ["wrapper/audit-code-wrapper-lib.mjs", true],
    ["tests/shared/contract-construction-sites.test.ts", false],
    ["tests/audit/fixtures/reporting.mjs", false],
    [".claude/hooks/commit-gate.mjs", false],
    ["docs/readme.md", false],
  ])("classifies %s as a producer: %s", (path, expected) => {
    expect(isProducerPath(path)).toBe(expected);
  });

  it("treats the registry's own declaration module as not-a-producer (it IS the contract)", () => {
    expect(isProducerPath("src/shared/types/contractPropertyShapes.ts")).toBe(false);
  });
});

describe("marker parsing", () => {
  it("reads a site marker and its type", () => {
    expect(parseSiteMarkers("// construction-site: Finding (the array)")).toEqual([
      { type: "Finding", note: "(the array)", exempt: false, fields: [] },
    ]);
  });

  it("reads a marker's declared FIELDS only from the literal `fields=` operand", () => {
    // The claim is checkable, so it is read; prose about the site is not a claim,
    // so it is not. Without this split a note saying "the `findings` array" would
    // bind the marker to a field name and red on a contract that has one.
    expect(parseSiteMarkers("// construction-site: Finding fields=id,title").map((m) => m.fields)).toEqual([
      ["id", "title"],
    ]);
    expect(parseSiteMarkers("// construction-site: Finding field=id").map((m) => m.fields)).toEqual([["id"]]);
    expect(
      parseSiteMarkers("// construction-site: Finding (the `findings` array)").map((m) => m.fields),
    ).toEqual([[]]);
    // A malformed operand yields no claim rather than a bogus name.
    expect(parseSiteMarkers("// construction-site: Finding fields=not-a-name!").map((m) => m.fields)).toEqual([
      [],
    ]);
  });


  it("reads an exemption, with the type AFTER the decision word", () => {
    // The two markers order their operands differently on purpose; a parser that
    // assumed one order reported the exemption's subject as "—".
    const [marker] = parseSiteMarkers(
      "// contract-construction-sites: exempt — AuditVerification is host-authored",
    );
    expect(marker.exempt).toBe(true);
    expect(marker.type).toBe("AuditVerification");
  });

  it("ignores a marker spelled differently — no near-miss is silently accepted", () => {
    expect(parseSiteMarkers("// construction site: Finding")).toEqual([]);
    expect(parseSiteMarkers("// sites-pinned: tests/a.test.ts")).toEqual([]);
  });

  it("does NOT read a marker quoted inside a string literal or mid-line", () => {
    // Measured: unanchored, this pattern matched the gate's OWN refusal text
    // (`\`// construction-site: ${contract.type}\``) and reported the gate as
    // declaring sites for the types "${contract.type}" and "<name>`". The gate
    // read its own error message as data.
    expect(parseSiteMarkers('  `// construction-site: ${contract.type}` at each site,')).toEqual([]);
    expect(parseSiteMarkers("const s = '// construction-site: Finding';")).toEqual([]);
    expect(parseSiteMarkers(" * `// construction-site: <Type>` — a doc sentence")).toEqual([]);
    // A real marker, indented, is still read.
    expect(parseSiteMarkers("    // construction-site: Finding").map((m) => m.type)).toEqual(["Finding"]);
  });
});

describe("the marker-field reconciliation over a registry row (D3)", () => {
  // The five forbidden verdict fields are omitted from the WORKER projection on
  // purpose, so a marker naming one is describing the wrong contract. Three of
  // them (`grounding`, `evidence_lane`, `verification_status`) ARE properties of
  // the shared Finding — the generic "the contract does not declare it" message
  // never fires for them, so without a NAMED branch the marker passed silently
  // while claiming a field no producer can set.
  // `severity_downgraded_from` and `lead_lineage` are FORBIDDEN and are
  // deliberately NOT properties here: the named branch has to fire for a field
  // the contract does not declare either, not only for the three that ARE
  // declared. Each forbidden field is refused with exactly ONE message — the
  // named one — so a reader is not handed a generic refusal to decode alongside
  // it.
  const FINDING_ROW = {
    schema: "FindingSchema",
    properties: {
      id: { kind: "other" },
      grounding: { kind: "object", allowsUndefined: true },
      evidence_lane: { kind: "other", allowsUndefined: true },
      verification_status: { kind: "other", allowsUndefined: true },
    },
  };

  const reconcile = (fields: string[]) =>
    reconcileContractSites({
      tracked: ["src/producer.ts"],
      readText: () =>
        `// construction-site: Finding fields=${fields.join(",")}\nconst x = { id: "1" };\n`,
      contractTypes: [{ type: "Finding", ...FINDING_ROW }],
      schemaProducers: {},
      schemaFiles: () => false,
    });

  it("refuses a marker naming a field the contract DOES declare but no producer may set", () => {
    const errors = reconcile(["evidence_lane"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("evidence_lane");
    expect(errors[0]).toContain("FORBIDDEN VERDICT FIELD");
    // The refusal says which operand to delete, not just that something is wrong.
    expect(errors[0]).toContain("Remove `evidence_lane` from the marker's `fields=` operand");
  });

  it.each(FORBIDDEN_MARKER_FIELDS)("names %s as forbidden rather than generic", (field) => {
    const errors = reconcile([field]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(field);
    expect(errors[0]).toContain("FORBIDDEN VERDICT FIELD");
  });

  it("leaves an ordinary declared field alone", () => {
    expect(reconcile(["id", "grounding"])).toHaveLength(1); // `grounding` is the forbidden one
    expect(reconcile(["id"])).toEqual([]);
  });

  it("still reports an undeclared field through the generic message", () => {
    const errors = reconcile(["id", "NOPE"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("NOPE");
    expect(errors[0]).toContain("the contract does not");
    expect(errors[0]).not.toContain("FORBIDDEN VERDICT FIELD");
  });
});

describe("derivation and refusal", () => {
  const files = (entries: Record<string, string>) =>
    Object.entries(entries).map(([file, text]) => ({ file, markers: parseSiteMarkers(text) }));

  it("derives a site per declaring producer, and keeps an EMPTY row for an undeclared type", () => {
    const { sites } = deriveConstructionSites(
      files({
        "src/audit/producer.ts": "// construction-site: Finding\n",
        "tests/one.test.ts": "// construction-site: Finding\n", // NOT a producer
      }),
      ["Finding", "AuditResult"],
    );
    expect(sites.get("Finding")?.sites).toEqual(["src/audit/producer.ts"]);
    // The denominator is the REGISTRY, so a type nothing declares still has a row
    // to refuse on — that absence is the defect being caught.
    expect(sites.get("AuditResult")?.sites).toEqual([]);
  });

  it("reports a marker naming a type the registry does not hold", () => {
    const { unknown } = deriveConstructionSites(
      files({ "src/a.ts": "// construction-site: Nonsense\n" }),
      ["Finding"],
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("Nonsense");
  });

  it("records an exemption separately from a site", () => {
    const { sites } = deriveConstructionSites(
      files({ "src/a.ts": "// contract-construction-sites: exempt — Finding is host-authored\n" }),
      ["Finding"],
    );
    expect(sites.get("Finding")?.sites).toEqual([]);
    expect(sites.get("Finding")?.exemptions).toEqual(["src/a.ts"]);
  });

  it("carries a type's declared FIELDS through the derivation, sorted and de-duplicated", () => {
    // Sorted so the reconciliation is order-stable across files; the field claim
    // is the only thing that makes a marker a statement about the CONTRACT
    // rather than about itself.
    const { sites } = deriveConstructionSites(
      files({
        "src/a.ts": "// construction-site: Finding fields=id,title\n",
        "src/b.ts": "// construction-site: Finding fields=title,severity\n",
      }),
      ["Finding"],
    );
    expect(sites.get("Finding")?.fields).toEqual(["id", "severity", "title"]);
  });
});

describe("rendered-schema reconciliation", () => {
  const contract = {
    properties: new Set(["a", "b"]),
    required: new Set(["a"]),
  };

  it("passes when the property sets are equal", () => {
    expect(
      reconcileRenderedSchema({
        schemaFile: "schemas/x.json",
        rendered: { properties: { a: {}, b: {} } },
        contract,
        message: "regenerate",
      }),
    ).toEqual([]);
  });

  it("refuses a field the contract added and the schema never got", () => {
    // THE DEFECT: a field added to the contract, the rendered schema left behind.
    const errors = reconcileRenderedSchema({
      schemaFile: "schemas/x.json",
      rendered: { properties: { a: {} } },
      contract,
      message: "regenerate",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("MISSING 1 field(s)");
    expect(errors[0]).toContain("b");
  });

  it("refuses a field the schema declares that the contract does not", () => {
    const errors = reconcileRenderedSchema({
      schemaFile: "schemas/x.json",
      rendered: { properties: { a: {}, b: {}, c: {} } },
      contract,
      message: "regenerate",
    });
    expect(errors.join("\n")).toContain("declares 1 field(s) the contract does not");
  });

  it("refuses a MARKER that names a field the contract does not declare", () => {
    // The half that makes a marker a claim about the CONTRACT rather than about
    // itself: a site that drifted off the type, or a marker copied onto a
    // consumer, both name a field this contract does not have.
    const errors = reconcileRenderedSchema({
      schemaFile: "X (declared markers)",
      rendered: { properties: { a: {}, b: {} } },
      contract,
      message: "marker drifted",
      markerFields: ["a", "NOPE"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("NOPE");
    expect(errors[0]).toContain("the contract does not");
  });

  it("does NOT read an absent marker-field list as a claim", () => {
    // A caller that derived no fields (or a type whose markers name none) makes
    // NO claim. Reding on that silence would be a gate crying wolf on its own
    // wiring, so the check is skipped rather than failed.
    expect(
      reconcileRenderedSchema({
        schemaFile: "X",
        rendered: { properties: { a: {}, b: {} } },
        contract,
        message: "m",
      }),
    ).toEqual([]);
    expect(
      reconcileRenderedSchema({
        schemaFile: "X",
        rendered: { properties: { a: {}, b: {} } },
        contract,
        message: "m",
        markerFields: [],
      }),
    ).toEqual([]);
  });

  it("accepts a declared field that the contract DOES have", () => {
    expect(
      reconcileRenderedSchema({
        schemaFile: "X",
        rendered: { properties: { a: {}, b: {} } },
        contract,
        message: "m",
        markerFields: ["a", "b"],
      }),
    ).toEqual([]);
  });
});

describe("the real tree", () => {
  it("every declaring producer in this repo resolves to a registry type", () => {
    // A marker naming a type no row holds would be a silent no-op that still
    // reads as coverage. Walked over the REAL producer sources.
    const types = new Set(CONTRACT_PROPERTY_SHAPES.map((c) => c.type));
    for (const rel of [
      "src/audit/cli/semanticReviewStep.ts",
      "src/shared/validation/designFindingGrounding.ts",
      "src/audit/orchestrator/partitionTaskGraph.ts",
    ]) {
      const markers = parseSiteMarkers(readFileSync(join(REPO_ROOT, rel), "utf8"));
      expect(markers.length, `${rel} declares no construction site`).toBeGreaterThan(0);
      for (const marker of markers) {
        expect(types.has(marker.type), `${rel} → unknown type ${marker.type}`).toBe(true);
      }
    }
  });
});
