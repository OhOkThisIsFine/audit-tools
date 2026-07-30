#!/usr/bin/env node
// Gate-enumeration parity: the prose lists of gate steps are GENERATED from
// package.json, never hand-maintained.
//
// The step ORDER and MEMBERSHIP come from package.json (the real gate); only the
// per-step human gloss comes from scripts/gate-enumeration-data.mjs. So this can
// never disagree with the gate about what runs or in what sequence — the failure
// mode it replaces was exactly that disagreement, twice in two nights.
//
// A step in package.json with no gloss is a HARD FAILURE rather than a silent
// pass-through of its bare script name: naming a new gate step once is the whole
// cost of keeping both docs correct forever, and a gate that quietly degrades to
// the raw name would let the docs drift in quality instead of in content.
//
//   node scripts/check-gate-enumeration.mjs            # verify (CI / commit gate)
//   node scripts/check-gate-enumeration.mjs --write     # regenerate the blocks
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { STEP_GLOSS, ENUMERATION_TARGETS } from "./gate-enumeration-data.mjs";

const root = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.cwd());
const write = process.argv.includes("--write");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The real steps of verify:checks, in the real order, off the real script. */
function verifyChecksSteps() {
  const script = pkg.scripts?.["verify:checks"] ?? "";
  // `node scripts/shared/profile-run.mjs verify-checks <step> <step> …`
  const marker = "verify-checks";
  const idx = script.indexOf(marker);
  if (idx < 0) throw new Error("check-gate-enumeration: verify:checks no longer runs through profile-run.mjs — update the parser");
  return script
    .slice(idx + marker.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const steps = verifyChecksSteps();

const missing = steps.filter((s) => !STEP_GLOSS[s]);
if (missing.length > 0) {
  console.error(
    `\n✗ gate-enumeration: ${missing.length} gate step(s) in package.json have no gloss:\n` +
      missing.map((s) => `  - ${s}`).join("\n") +
      `\n\nAdd each to STEP_GLOSS in scripts/gate-enumeration-data.mjs, then re-render:\n` +
      `  node scripts/check-gate-enumeration.mjs --write\n`,
  );
  process.exit(1);
}

const failures = [];
for (const target of ENUMERATION_TARGETS) {
  const path = join(root, target.file);
  const source = readFileSync(path, "utf8");
  const begin = `<!-- BEGIN ${target.marker} — generated from package.json by scripts/check-gate-enumeration.mjs -->`;
  const end = `<!-- END ${target.marker} -->`;

  const b = source.indexOf(begin);
  const e = source.indexOf(end);
  if (b < 0 || e < 0 || e < b) {
    failures.push(`${target.file}: missing the ${target.marker} markers — add them around the step list`);
    continue;
  }

  const body = `\n\n${target.render(steps)}\n\n`;
  const rebuilt = source.slice(0, b + begin.length) + body + source.slice(e);

  if (rebuilt === source) continue;
  if (write) {
    writeFileSync(path, rebuilt, "utf8");
    console.log(`rewrote ${target.file}`);
  } else {
    failures.push(`${target.file}: the generated ${target.marker} block is STALE — run \`node scripts/check-gate-enumeration.mjs --write\``);
  }
}

if (failures.length > 0) {
  console.error(`\n✗ gate-enumeration:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  console.error("These lists restate package.json's gate. They are generated so a new gate step");
  console.error("cannot silently leave both docs wrong — which happened on two consecutive nights.\n");
  process.exit(1);
}

console.log(`✓ gate-enumeration: ${steps.length} gate steps rendered identically in ${ENUMERATION_TARGETS.length} docs`);
