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
let scanned = 0;
for (const file of tracked) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch (error) {
    // `git ls-files` describes the index. During an atomic retirement the
    // working tree can legitimately contain unstaged deletions, which are not
    // source bytes this gate can inspect. Skip only that exact race/state;
    // permission and other IO failures must still fail the gate.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
    throw error;
  }
  scanned += 1;
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

console.log(`check-control-bytes: ${scanned} present tracked source files clean`);
