// Assertion-parity audit for the .mjs -> .ts test-conversion ratchet
// (docs/backlog/open-bugs.md — "Convert the test tree ... the conversion IS the
// typecheck ratchet"). Run it from a conversion lap AFTER `git mv` + edits, BEFORE
// commit: for each staged .mjs -> .ts rename it extracts assertion lines
// (expect(/assert.) from HEAD's .mjs and the working tree's .ts, normalizes
// whitespace, and compares multiset counts. Files whose assertion content diverges
// are the ONLY ones needing human/LLM review — type-only edits (annotations,
// imports, narrowing helpers) never touch assertion lines, so a clean file here
// means no assertion was dropped or reworded by the conversion.
//
//   node scripts/shared/conversion-assertion-parity.mjs   # from the repo root
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true }).trim();
const renames = execFileSync("git", ["diff", "--cached", "--name-status", "-M"], { cwd: repo, encoding: "utf8", windowsHide: true })
  .split("\n")
  .filter((l) => /^R\d+\ttests\/.*\.test\.mjs\ttests\/.*\.test\.ts$/.test(l))
  .map((l) => {
    const [, from, to] = l.split("\t");
    return { from, to };
  });

const norm = (s) =>
  s
    .replace(/\s+/g, " ")
    .trim();

// A line "counts" if it invokes an assertion. Multi-line assertion calls are
// captured by their first line, which is where the matcher/subject lives.
const isAssert = (l) =>
  /\bexpect\s*\(/.test(l) || /\bassert\s*[.(]/.test(l);

const tally = (text) => {
  const m = new Map();
  for (const line of text.split("\n")) {
    if (!isAssert(line)) continue;
    const k = norm(line);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};

let flagged = 0;
for (const { from, to } of renames) {
  const oldText = execFileSync("git", ["show", `HEAD:${from}`], { cwd: repo, encoding: "utf8", windowsHide: true });
  const newText = readFileSync(`${repo}/${to}`, "utf8");
  const a = tally(oldText);
  const b = tally(newText);
  const missing = []; // in .mjs, absent from .ts
  const added = []; // in .ts, absent from .mjs
  for (const [k, n] of a) {
    const bn = b.get(k) ?? 0;
    if (bn < n) missing.push(`${n - bn}x ${k}`);
  }
  for (const [k, n] of b) {
    const an = a.get(k) ?? 0;
    if (an < n) added.push(`${n - an}x ${k}`);
  }
  if (missing.length || added.length) {
    flagged++;
    console.log(`\n### ${to}  (old asserts: ${[...a.values()].reduce((x, y) => x + y, 0)}, new: ${[...b.values()].reduce((x, y) => x + y, 0)})`);
    for (const m of missing.slice(0, 20)) console.log(`  - GONE:  ${m}`);
    for (const m of added.slice(0, 20)) console.log(`  + NEW:   ${m}`);
    if (missing.length > 20 || added.length > 20) console.log(`  ... (${missing.length} gone / ${added.length} new total)`);
  }
}
console.log(`\n${renames.length} converted files audited; ${flagged} with assertion-line divergence.`);
