// The register of RETIRED infrastructure — held as data, so a retirement is a
// one-line edit here rather than a sweep somebody has to remember.
//
// WHY THIS EXISTS. `docs/backlog/durable-traps.md` is a standing REFERENCE: a
// session reads it precisely when it is unsure what to run, so an entry naming
// a service that was shut down months ago does not merely waste a read — it
// sends the reader to a wrong action, and the machine-wide `CLAUDE.md` warns
// that one of them (`claude.ps1`) would RESURRECT the retired service by
// starting it. Before this register, eight entries documented the FreeLLMAPI
// router as though it were live; they were retired 2026-08-29 and the file was
// corrected 2026-09-10 only because a scope audit happened to look. The stated
// property is "an entry naming infrastructure that no longer exists is deleted
// or dated when that infrastructure RETIRES, driven by the retirement rather
// than by someone later noticing" — and that direction is exactly what a
// register buys: retiring something means ADDING ITS ROW, and
// `scripts/check-retired-infrastructure.mjs` then finds every doc still
// carrying it, at the commit that retired it.
//
// EXEMPTION is explicit and inline, the same idiom `check-doc-code-citations`
// already uses, never inferred from prose: an HTML comment
//     <!-- retired-infrastructure-exempt: <id> — <reason> -->
// on the line above (or on the same line as) the mention exempts that line.
// That marker IS the "dated statement" half of the property — a doc that
// deliberately records a retirement writes one and says what replaced it, and
// everything else is red. The gate does not attempt to classify tense; a
// present-tense instruction and a past-tense record are the same characters.
//
// ENTRY SHAPE. `patterns` are LITERAL identifiers — a product name, a launcher
// path, a port, a tool prefix. They are matched case-insensitively against the
// whole line, so keep each one narrow enough that a live thing cannot contain
// it: `3001` alone would match a timestamp, `127.0.0.1:3001` would not.
//
// ADDING A ROW IS THE RETIREMENT STEP. There is deliberately no `unretired`
// field and no expiry: a thing that comes BACK gets its row removed, which is
// the same one-line edit in the same one place.

/**
 * @typedef {object} RetiredInfrastructure
 * @property {string} id stable slug; the exemption marker names it
 * @property {string} label how the refusal names it to a reader
 * @property {string} retired ISO date the retirement took effect
 * @property {string} replacedBy what a reader should use instead
 * @property {{name: string, pattern: RegExp}[]} patterns literal identifiers
 */

/** @type {RetiredInfrastructure[]} */
export const RETIRED_INFRASTRUCTURE = [
  {
    id: "freellmapi",
    label: "the FreeLLMAPI router",
    retired: "2026-08-29",
    replacedBy:
      "llm-relay on `127.0.0.1:8791` (`llm-relay dispatch`; liveness `GET /telemetry`)",
    patterns: [
      { name: "its product name", pattern: /\bfreellmapi\b/i },
      { name: "its launcher", pattern: /\bclaude\.ps1\b/i },
      { name: "its launcher (sibling)", pattern: /\bstart\.ps1\b/i },
      { name: "its port", pattern: /127\.0\.0\.1:3001/ },
      { name: "its MCP tool prefix", pattern: /mcp__freellmapi__offload_/ },
      { name: "its credential prefix", pattern: /\bfreellmapi-/ },
    ],
  },
];
