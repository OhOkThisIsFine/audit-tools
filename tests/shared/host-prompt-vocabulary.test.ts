/**
 * Host-facing prompt vocabulary guard.
 *
 * WHY THIS EXISTS (open-bugs, 2026-10-01: "Audit prompts still say 'subagent'
 * and the loader still talks to audit-tools developers"). Backlog entries O49
 * and O03 required (O49) that both drivers state the independence NEED rather
 * than a sub-agent MECHANISM the host may not have, and (O03) that the shipped
 * loader carry no audit-tools development instruction and no "read the JSON
 * only far enough" instruction. Both were closed with the defect present,
 * because the only absence assertion was one remediate item-prompt test: the
 * audit driver, the shared fan-out renderer and the loaders were never held to
 * the rule. A per-prompt test cannot hold it either — a new emitter is a new
 * site nobody remembers to pin.
 *
 * So the guard is a property of the TREE, in both polarities:
 *
 *   1. Every string and template literal in the shipped code (`src/**`, which
 *      builds both drivers and the shared renderers, and `wrapper/**`, which
 *      renders the installed host assets) is free of the mechanism noun.
 *      Comments are not prompt text and are not scanned; literals are where
 *      every host prompt is authored.
 *   2. Every shipped loader asset (`skills/**`) and every tracked rendered copy
 *      of one is free of the mechanism noun, the development-only line and the
 *      "far enough" read instruction.
 *
 * The scanners are also driven over planted fixtures, so each failure mode is
 * watched firing rather than assumed.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** The mechanism noun. Independence is a property of the context, not of a sub-agent. */
const MECHANISM_NOUN = /sub-?agent/i;

/** Lines a shipped loader must never carry, each with the reason it is banned. */
const LOADER_BANNED: { pattern: RegExp; reason: string }[] = [
  { pattern: MECHANISM_NOUN, reason: "names a delegation mechanism instead of the need" },
  {
    pattern: /developing audit-tools|audit-tools itself/i,
    reason: "a development instruction for audit-tools reaches every third-party run",
  },
  {
    pattern: /far enough/i,
    reason: "asks the host to read the step JSON partially; the whole record is already in context",
  },
];

/** Rendered host copies of the loaders that are tracked in this repository. */
const TRACKED_RENDERED_LOADERS = [
  ".agent/skills/audit-code/SKILL.md",
  ".agent/skills/remediate-code/SKILL.md",
  ".gemini/commands/audit-code.toml",
  ".gemini/commands/remediate-code.toml",
  ".github/agents/auditor.agent.md",
  ".github/agents/remediator.agent.md",
  ".github/prompts/audit-code.prompt.md",
  ".github/prompts/remediate-code.prompt.md",
];

function filesUnder(dir: string, keep: (path: string) => boolean): string[] {
  return (readdirSync(join(repoRoot, dir), { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
    .filter(keep)
    .sort();
}

/** Every string/template literal fragment in `source` that matches `pattern`, with its line. */
function literalHits(fileName: string, source: string, pattern: RegExp): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (pattern.test(node.text)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        hits.push(`${fileName}:${line}: ${node.text.slice(0, 120)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

function loaderHits(path: string, text: string): string[] {
  return LOADER_BANNED.flatMap(({ pattern, reason }) =>
    text
      .split(/\r?\n/)
      .flatMap((line, index) => (pattern.test(line) ? [`${path}:${index + 1}: ${reason}: ${line.trim()}`] : [])),
  );
}

describe("host prompt vocabulary — the scanners fire", () => {
  it("finds the mechanism noun in a string, a template part and a no-substitution template, and ignores comments", () => {
    const source = [
      "// a subagent in a comment is not prompt text",
      'const a = "dispatch a subagent";',
      "const b = `one sub-agent per ${lane} lane`;",
      "const c = `Sub-Agent facility`;",
      'const d = "an independent context";',
    ].join("\n");
    const hits = literalHits("fixture.ts", source, MECHANISM_NOUN);
    expect(hits.map((hit) => hit.split(":")[1])).toEqual(["2", "3", "4"]);
  });

  it("finds each banned loader line", () => {
    const text = [
      "Assign items with the host's native subagent facilities.",
      "When developing audit-tools itself, use the wrapper.",
      "Read the returned JSON only far enough to find `prompt_path`.",
      "Read and follow the prompt at `prompt_path`.",
    ].join("\n");
    expect(loaderHits("fixture.md", text).map((hit) => hit.split(":")[1])).toEqual(["1", "2", "3"]);
  });
});

describe("host prompt vocabulary — the shipped tree", () => {
  it("no string or template literal in src/ or wrapper/ names the sub-agent mechanism", () => {
    const sources = [
      ...filesUnder("src", (path) => path.endsWith(".ts") && !path.endsWith(".d.ts")),
      ...filesUnder("wrapper", (path) => /\.(?:mjs|js|ts)$/.test(path)),
    ];
    expect(sources.length).toBeGreaterThan(0);
    const hits = sources.flatMap((path) =>
      literalHits(path, readFileSync(join(repoRoot, path), "utf8"), MECHANISM_NOUN),
    );
    expect(hits, "state the independence need (an independent context), never a delegation mechanism").toEqual([]);
  });

  it("no shipped loader asset or tracked rendered copy carries a banned line", () => {
    const assets = [...filesUnder("skills", () => true), ...TRACKED_RENDERED_LOADERS];
    const hits = assets.flatMap((path) => loaderHits(path, readFileSync(join(repoRoot, path), "utf8")));
    expect(hits).toEqual([]);
  });
});
