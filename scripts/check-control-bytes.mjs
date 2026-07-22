#!/usr/bin/env node
//
// Raw-control-byte gate.
//
// A literal control byte (e.g. 0x00 from a `\0` template literal landing via
// the Write tool) compiles fine under tsc but turns the source file BINARY to
// git/grep — every code search over it silently returns nothing. Bit twice
// (consensus.ts pairKey 2026-07-05, friction/triage.ts 2026-07-22), so the
// property is enforced here instead of relied on as authoring discipline:
// tracked source may contain no byte < 0x20 except tab / LF / CR. Use the
// `\uXXXX` escape the compiler resolves at runtime instead.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SOURCE_EXT = /\.(ts|mts|cts|js|mjs|cjs|json|md|ya?ml)$/;

function git(args) {
  // win32: suppress the console-window flash on every gate run — INV-WH.
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true });
}

const tracked = git(['ls-files'])
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((p) => p && SOURCE_EXT.test(p));

const violations = [];
for (const file of tracked) {
  const buf = readFileSync(file);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      const line = buf.subarray(0, i).toString('utf8').split('\n').length;
      violations.push(`${file}:${line} raw control byte 0x${b.toString(16).padStart(2, '0')}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Raw control byte(s) in tracked source (grep/git treat the file as binary):');
  for (const v of violations) console.error(`  ${v}`);
  console.error('Replace with the equivalent \\uXXXX escape — the compiler resolves it at runtime.');
  process.exit(1);
}

console.log(`check-control-bytes: ${tracked.length} tracked source files clean`);
