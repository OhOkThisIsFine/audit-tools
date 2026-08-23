// The canonical doc manifest, HELD AS DATA.
//
// WHY DATA AND NOT PROSE. The manifest used to be readable only as markdown, and
// the checker recovered it by regexing backticked `docs/…md` tokens out of the
// WHOLE guidelines file. Three failure modes followed, all of them silent:
//
//   1. A doc merely MENTIONED in prose (or in a row's rationale text) counted as
//      registered — `remediation-report.md` was "registered" solely because the
//      excluded row's rationale said "structurally parallel to its
//      `remediation-report.md` sibling".
//   2. Any token containing `*` was DISCARDED, so the `spec/**/*.md` row matched
//      nothing and 22 spec docs were unrouted.
//   3. A row could point at a file deleted months earlier without anyone
//      noticing (`meta-audit-log.md` sat dead in the excluded row for ~8 weeks —
//      the regex required a `docs/` prefix, so the missing-file check never even
//      considered it).
//
// Holding the rows as structured data makes all three impossible by
// construction: paths live in `files`, rationale lives in a per-entry NOTE or in
// the `check` column, and the human-readable table in
// `docs/doc-review-guidelines.md` is RENDERED from this array and byte-compared
// against it by `scripts/check-doc-manifest.mjs` (`--write` regenerates it).
// There is no prose the checker can misread, because it reads no prose.
//
// ENTRY SHAPE. Each `files` entry is either
//   "path/to/doc.md"                      — an exact repo-relative path, or
//   ["glob/pattern.md", "why it's here"]  — a pattern plus a short note.
// (The 2-tuple form works for exact paths too when a note is worth carrying.)
//
// GLOB GRAMMAR (compiled in check-doc-manifest.mjs):
//   `*`      any run of characters within one path segment
//   `**/`    any number of leading path segments, including none
//   `?`      exactly one character within a segment
//   `<date>` an ISO date with an optional lap suffix — \d{4}-\d{2}-\d{2}[a-z]?
//
// ROW SHAPE. `{ type, files, check, autoApply }`. There is deliberately no
// "this row's files need not exist" escape hatch: the `excluded` row used to
// carry one, and that is exactly how `meta-audit-log.md` stayed registered for
// eight weeks after being deleted.
//
// INVARIANTS, all mechanically enforced by scripts/check-doc-manifest.mjs:
//   • every tracked `*.md` in the repo matches exactly one row;
//   • every exact entry names a tracked file;
//   • every pattern matches at least one tracked file (no dead rules);
//   • the rendered table in docs/doc-review-guidelines.md matches this data.
// Adding a doc means adding it here — nowhere else.

/** @typedef {string | [string, string]} ManifestEntry */
/**
 * @typedef {object} ManifestRow
 * @property {string} type
 * @property {ManifestEntry[]} files
 * @property {string} check
 * @property {string} autoApply
 */

/** @type {ManifestRow[]} */
export const DOC_MANIFEST = [
  {
    type: "design / concept",
    files: [
      "docs/documentation-philosophy.md",
      "docs/project-philosophy.md",
      "docs/glossary-ids.md",
      "docs/end-of-sprint-report-template.md",
    ],
    check:
      "Claims vs code (drift); flag current-state / changelog creep (docs are timeless concepts, not status). " +
      "`project-philosophy.md` is an orienting **map** (product-vs-development split) that points at each " +
      "conviction's canonical home — verify its one-line restatements still match those homes; it deliberately " +
      "references, never re-owns, so a home change makes its pointer stale, not the home.",
    autoApply: "factual-stale → yes",
  },
  {
    type: "instruction / policy",
    files: ["CLAUDE.md", "AGENTS.md"],
    check: "Factual claims only (file/command/path staleness). Policy & conventions untouchable.",
    autoApply:
      "**No — escalate-only.** Highest blast radius: a wrong edit deletes a guardrail governing all agents.",
  },
  {
    type: "ops / usage",
    files: ["README.md"],
    check: "Do the documented commands / paths still resolve and run.",
    autoApply: "factual-stale → yes",
  },
  {
    type: "package docs (audit)",
    files: [
      "docs/audit-pkg/product.md",
      "docs/audit-pkg/contracts.md",
      "docs/audit-pkg/development.md",
      "docs/audit-pkg/operator-guide.md",
      "docs/audit-pkg/release.md",
    ],
    check:
      "Claims vs code/spec (these page the normative `spec/audit/*`); flag current-state / changelog creep.",
    autoApply: "factual-stale → yes",
  },
  {
    type: "backlog",
    files: [
      "docs/backlog.md",
      "docs/backlog/open-bugs.md",
      "docs/backlog/forward-tracks.md",
      "docs/backlog/deferred.md",
      "docs/backlog/durable-traps.md",
    ],
    check:
      "Shipped-detection (see *Shipped-entry deletion* below — a fully-shipped entry is **deleted outright**, " +
      "never kept as a `SHIPPED`/`FIXED`/`DONE` marker; a partial entry is **trimmed to its open remainder**); " +
      "dedup near-identical raw items; A→B draft (below). Durable-traps section is **reference** — only flag a " +
      "trap proven fixed-in-tooling.",
    autoApply: "shipped-removal & dedup → yes; A→B → escalate",
  },
  {
    type: "handoff (sequencing view)",
    files: ["docs/HANDOFF.md"],
    check:
      "Current published state + immediate next only (sanctioned per the philosophy's HANDOFF row). " +
      "The roadmap block is generated from `▶`-pinned backlog entries; the live nightly block is generated " +
      "from the persisted queue + decision ledger and must render no visible nightly text when the queue is empty. " +
      "Never hand-edit either generated block. Flag **changelog creep** and per-item specs duplicated from their " +
      "authoritative backlog/queue source; verify hand-written current state against code and clear stale state with proof.",
    autoApply: "hand-written state → yes; generated blocks → generator only",
  },
  {
    type: "design / concept (`spec/`)",
    files: [
      [
        "spec/**/*.md",
        "the normative design corpus — workflow designs, contracts, goals docs; routed by pattern, so a new spec is registered the moment it lands. A `*.generated.md` sibling is NOT part of that corpus — see the check column",
      ],
    ],
    check:
      "Claims vs code (drift); flag current-state / changelog creep (durable design only). A " +
      "`> **Status:** <type-declaration>` preamble identifying the kind of design artifact is permitted; a " +
      "dated/versioned status string in it is still status-noise → escalate. The goals docs and the " +
      "`spec/audit/*` contracts are **normative** — see *Normative goals docs* above and the constitutional-doc " +
      "refusal in `src/shared/constitutionalDocPaths.ts`: a change to one is a design-decision → escalate. " +
      "A `spec/**/*.generated.md` file is a whole-file generator render (its banner names the generator) — " +
      "never hand-edit it; a stale claim there is a stale SOURCE, fixed by editing the source and re-running " +
      "the generator, and its `check:` gate refuses the commit otherwise.",
    autoApply:
      "factual-stale → yes (except the constitutional subset — escalate-only; `*.generated.md` — generator only)",
  },
  {
    type: "excluded",
    files: [
      ["docs/doc-review-guidelines.md", "this spec — excluded from its own review"],
      [
        "docs/reviews/*-<date>.md",
        "dated review / plan / diagnosis / dogfood records — excluded BY CONSTRUCTION. Each is a one-off record of what was decided on a day, never a timeless concept; the durable outcome lives in `spec/`, the backlog, or project memory. This pattern replaced a 21.5k-character exhaustive list that grew every lap",
      ],
      [
        ".audit-tools/nightly/proposals/**/*.md",
        "nightly leg-3 proposal records — the full analysis behind an escalated item (recurrence evidence, proposed mechanism, false-positive surface). TRACKED so a proposal outlives the machine that produced it, but excluded BY CONSTRUCTION for the same reason as a dated review: each is a one-off record of a proposition as it stood that night, never a timeless concept. They deliberately cite paths that do not exist — a file the proposal proposes CREATING, or one deleted since — so reviewing them for staleness, or citation-checking them, would be checking a historical record against a present tree. Accepted outcomes land in code, `spec/`, the backlog or memory; the record stays as provenance",
      ],
      [
        ".audit-tools/audit-report.md",
        "runtime run-artifact — an audit-code run output per `CLAUDE.md`'s Artifact layout; tracked but never reviewed",
      ],
      [
        ".audit-tools/remediation-report.md",
        "runtime run-artifact — a remediate-code run output per `CLAUDE.md`'s Artifact layout; tracked but never reviewed",
      ],
      [
        "tests/audit/fixtures/simple-app/README.md",
        "test-fixture content — a sample-app README, its own concern, not a project doc",
      ],
    ],
    check: "—",
    autoApply: "—",
  },
  {
    type: "generated host assets",
    files: [
      ".agent/skills/audit-code/SKILL.md",
      ".agent/skills/remediate-code/SKILL.md",
      ".github/agents/auditor.agent.md",
      ".github/agents/remediator.agent.md",
      ".github/copilot-instructions.md",
      ".github/prompts/audit-code.prompt.md",
      ".github/prompts/remediate-code.prompt.md",
    ],
    check:
      "ONE canonical body rendered per-IDE (`CLAUDE.md` B5); **not hand-edited** — governed by renderer drift " +
      "tests (`tests/audit/host-asset-renderer-drift.test.ts`, " +
      "`tests/remediate/host-bootstrap-descriptors-remediate.test.ts`, " +
      "`tests/remediate/install-repo-assets.test.ts`). Review the canonical source, not the generated copy; a " +
      "diff = a drift-test/renderer gap, not a doc edit.",
    autoApply: "**No — renderer-owned.**",
  },
  {
    type: "canonical loader bodies",
    files: [
      "skills/audit-code/SKILL.md",
      "skills/audit-code/audit-code.prompt.md",
      "skills/remediate-code/SKILL.md",
      "skills/remediate-code/remediate-code.prompt.md",
    ],
    check:
      "HAND-AUTHORED sources, not generated output — the arrow points OUT of `skills/`: the renderer drift " +
      "tests read these as the canonical body and assert the `.agent/**` and `.github/**` copies equal a fresh " +
      "render of them, and `scripts/audit/postinstall.mjs` copies one outward as its literal prompt source. " +
      "Nothing writes into `skills/`. Review them like any other doc — in particular the CLI invocations and " +
      "flag literals they carry, which no other reviewer checks. Run `npm test` after editing (the drift tests " +
      "will fail until the generated copies are re-rendered).",
    autoApply: "Yes — with the renderer drift tests re-run.",
  },
  {
    type: "generated scheduler prompt",
    files: ["docs/nightly-routine-prompt.md"],
    check:
      "WHOLE-FILE GENERATED from `docs/nightly-routine.md` (cross-leg routine) + " +
      "`docs/doc-review-guidelines.md` (leg-1 rubric) by `scripts/check-nightly-routine-prompt.mjs`. " +
      "Never hand-edit or resolve a conflict in the target; edit the owning source and regenerate. " +
      "`check:nightly-routine-prompt` gates byte parity plus its `package.json` check/release wiring " +
      "in `verify:checks` and at commit.",
    autoApply: "**No — generator-owned.**",
  },
  {
    type: "generated decision inbox",
    files: ["docs/nightly-inbox.md"],
    check:
      "GENERATED by `scripts/nightly/render-inbox.mjs` from `.audit-tools/nightly/open-items.json` — " +
      "the nightly routine's answering surface, and the ONE tracked doc that is deliberately " +
      "current-state rather than timeless. The owner answers by ticking a checkbox; " +
      "`scripts/nightly/ingest-answers.mjs` reads the ticks into `.claude/nightly-decisions.json` and " +
      "re-renders, so answered items drop out on their own. Everything except the ticked boxes and the " +
      "`notes` blocks is rewritten on each run — review the item CONTENT at its source " +
      "(`.audit-tools/nightly/open-items.json`), never by hand-editing this file. Its status-noise is the point: it is a " +
      "work queue, the same sanctioned exception as `docs/HANDOFF.md`.",
    autoApply: "**No — generator-owned** (and the owner's answers are the only hand-written part).",
  },
  {
    type: "meta-tooling / dev-workflow",
    files: [
      ".claude/skills/design-check/SKILL.md",
      ".claude/skills/disambiguate-backlog/SKILL.md",
      ".claude/skills/ship/SKILL.md",
      ".claude/skills/start-lap/SKILL.md",
      "docs/nightly-routine.md",
    ],
    check:
      "Standalone dev-workflow how-to and scheduler-prompt SOURCE; do the documented commands/paths " +
      "still resolve. Changes to `docs/nightly-routine.md` must regenerate the generated scheduler prompt.",
    autoApply: "factual-stale → yes",
  },
  {
    type: "package READMEs (non-`docs/`)",
    files: ["src/audit/README.md", "src/audit/adapters/README.md", "examples/README.md"],
    check:
      "Claims vs code; do documented commands, paths, provider-neutral host-workload contracts, and result-ingestion " +
      "boundaries still resolve. These docs must not reintroduce a provider registry, execution adapter, or quota surface.",
    autoApply: "factual-stale → yes",
  },
];
