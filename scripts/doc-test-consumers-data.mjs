// The declared doc → test consumer map, HELD AS DATA.
//
// WHY THIS EXISTS. A contract-bearing doc edit has no edit-time surface naming
// the tests that assert its content. `docs/nightly-routine.md`'s approved lane
// swap was green through every local doc gate and failed release CI on the
// nightly-prompt parity test — which pinned the retired helper invocation
// verbatim — burning tag v0.34.40. The cost was not the failure; it was that the
// failure was only discoverable by running the whole suite, which no doc edit
// does, and the durable fix named in the record is exactly this: a DECLARED map.
//
// SHAPE. One row per doc whose CONTENT is asserted by a test — `doc` is the
// tracked doc path (exact, or a `glob`-free suffix pattern is NOT supported: a
// precise path is the point), `tests` are the test files that assert it, and
// `what` states what the test pins, so a reader can judge whether their edit
// touches it.
//
// This is a CURATED map, not a derived one, and deliberately so: an
// assertion-by-assertion derivation would need to know which string in a test
// came from which doc, which is the same undecidable provenance problem the
// acquired-analyzer boundary already declares. What is mechanical is that a doc
// IN this map cannot be edited without the map handing the editor its tests.
// A doc NOT in the map is not claimed to be uncovered — only unclaimed, and the
// gate says so in its pass line rather than implying coverage.

/** @typedef {object} DocTestConsumerRow */
/** @type {DocTestConsumerRow[]} */
export const DOC_TEST_CONSUMERS = [
  {
    doc: "docs/HANDOFF.md",
    tests: ["tests/shared/handoff-roadmap.test.ts", "tests/shared/closeout-render.test.ts"],
    what: "the roadmap block is generated from `▶`-pinned backlog entries and the live nightly block renders nothing when the queue is empty; the closeout render reproduces it verbatim",
  },
  {
    doc: "docs/project-philosophy.md",
    tests: [
      "tests/shared/philosophy-brief-gate.test.ts",
      "tests/shared/glossary-citations-backticked.test.ts",
    ],
    what: "README's Philosophy section is GENERATED from the brief's Product half, and the doc's citations are backticked so check:doc-code-citations can see them",
  },
  {
    doc: "docs/glossary-ids.md",
    tests: ["tests/shared/glossary-citations-backticked.test.ts"],
    what: "every path-shaped token in a table row is backticked, so a deleted file cannot stay green in the citation gate",
  },
  {
    doc: "docs/nightly-routine.md",
    tests: ["tests/shared/lane-dispatch.test.ts"],
    what: "the routine's lane dispatch and the doc's approved lane swap are asserted together",
  },
  {
    doc: "docs/backlog.md",
    tests: ["tests/shared/backlog-index.test.ts", "tests/shared/backlog-budget-unit.test.ts"],
    what: "the seek index is GENERATED from docs/backlog/, and the size baseline is a ratchet",
  },
  {
    doc: "docs/doc-review-guidelines.md",
    tests: ["tests/shared/doc-manifest-gate.test.ts"],
    what: "the routing table is RENDERED from scripts/doc-manifest-data.mjs and byte-compared",
  },
  {
    doc: "docs/documentation-philosophy.md",
    tests: ["tests/shared/doc-manifest-gate.test.ts"],
    what: "routed by the manifest and named as a constitutional doc; an edit is escalate-only",
  },
  {
    doc: "CLAUDE.md",
    tests: ["tests/shared/agents-region-gate.test.ts", "tests/shared/doc-manifest-gate.test.ts"],
    what: "AGENTS.md's generated region states CLAUDE.md's current size, and CLAUDE.md is routed + constitutional",
  },
  {
    doc: "AGENTS.md",
    tests: ["tests/shared/agents-region-gate.test.ts"],
    what: "the generated region must state CLAUDE.md's current size",
  },
  {
    doc: "README.md",
    tests: [
      "tests/shared/philosophy-brief-gate.test.ts",
      "tests/shared/generated-artifact-registry.test.ts",
    ],
    what: "the Philosophy section is a generated render of the brief, and the README sample-report block is a registered generated artifact (scripts/check-readme-sample-report.mjs)",
  },
];
