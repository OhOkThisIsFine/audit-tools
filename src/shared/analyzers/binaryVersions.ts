// sites-pinned: tests/shared/binary-versions.test.ts
/** Exact tagged upstream stdout grammars. Compatibility pins are compared by the resolver. */
function lines(stdout: string): string[] {
  const text = stdout.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return text.split("\n");
}
export function parseGitleaksVersion(stdout: string): string | null {
  const records = lines(stdout);
  return records.length === 1 && /^\d+\.\d+\.\d+$/.test(records[0]) ? records[0] : null;
}
export function parseOsvScannerVersion(stdout: string): string | null {
  const records = lines(stdout);
  if (records.length !== 4 || !/^osv-scalibr version: [^\r\x1b]+$/.test(records[1]) ||
      !/^commit: [^\r\x1b]+$/.test(records[2]) || !/^built at: [^\r\x1b]+$/.test(records[3])) return null;
  return /^osv-scanner version: (\d+\.\d+\.\d+)$/.exec(records[0])?.[1] ?? null;
}
export function parseHadolintVersion(stdout: string): string | null {
  const records = lines(stdout);
  return records.length === 1 ? /^Haskell Dockerfile Linter (\d+\.\d+\.\d+)$/.exec(records[0])?.[1] ?? null : null;
}
export function parseActionlintVersion(stdout: string): string | null {
  if (stdout.includes("\x1b")) return null;
  const records = lines(stdout);
  if (records.length !== 3 || !/^[^\r\x1b]+$/.test(records[1]) ||
      !/^built with [^\r\x1b]+ compiler for [^\s/]+\/[^\s/]+$/.test(records[2])) return null;
  return /^v?(\d+\.\d+\.\d+)$/.exec(records[0])?.[1] ?? null;
}
