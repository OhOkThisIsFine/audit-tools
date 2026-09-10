#!/usr/bin/env node
// Gate-enumeration parity: the prose lists of gate steps are GENERATED from
// package.json, never hand-maintained.
//
// Step ORDER, MEMBERSHIP and rendering all come from package.json (the real
// gate) plus the consumer's shape in scripts/gate-enumeration-data.mjs, so this
// can never disagree with the gate about what runs or in what sequence — the
// failure mode it replaces was exactly that disagreement, twice in two nights.
//
// There is no per-step description to keep in sync: `STEP_GLOSS` was removed
// (backlog 2026-08-27 / ceremony review 2026-08-29) because the one registered
// target renders step names alone, so a description reached no reader while
// every new gate step had to pay for one.
//
//   node scripts/check-gate-enumeration.mjs            # verify (CI / commit gate)
//   node scripts/check-gate-enumeration.mjs --write     # regenerate the blocks
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ENUMERATION_TARGETS } from "./gate-enumeration-data.mjs";
import { verifyChecksSteps } from "./shared/verify-steps.mjs";

const root = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.cwd());
const write = process.argv.includes("--write");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The real steps of verify:checks, in the real order, off the real script —
// read through the ONE parser `check:guard-reach` also uses.
const steps = verifyChecksSteps(pkg.scripts);

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

console.log(
  `✓ gate-enumeration: ${steps.length} gate steps rendered identically in ${ENUMERATION_TARGETS.length} doc(s)`,
);
