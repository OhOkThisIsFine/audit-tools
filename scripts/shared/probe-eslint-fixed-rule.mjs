// sites-pinned: tests/probe-eslint-fixed-rule.test.mjs
// Opt-in developer experiment, not a coverage receipt or normal analyzer.
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCodeUnits, resolveWithinRoot } from "./primitives.mjs";

const RULE = "no-debugger";
const VERSION = "v10.8.1";

/** @param {string} text @param {number | null} exitCode @param {readonly string[]} expected */
export function qualifyFixedRuleRows(text, exitCode, expected) {
  const rows = JSON.parse(text);
  const missing = new Set(expected);
  if (!missing.size || missing.size !== expected.length || !Array.isArray(rows) ||
      (exitCode !== 0 && exitCode !== 1)) throw new Error("Incomplete ESLint invocation or file inventory");
  const report = rows.map(row => {
    const path = resolve(row.filePath);
    if (!isAbsolute(row.filePath) || !missing.delete(path) || !Array.isArray(row.messages) ||
        !Array.isArray(row.suppressedMessages) || row.suppressedMessages.length ||
        row.fatalErrorCount !== 0 || row.warningCount !== 0 || row.errorCount !== row.messages.length) {
      throw new Error("Unexpected, duplicated, suppressed, or incomplete ESLint row");
    }
    const findings = row.messages.map(message => {
      if (message.ruleId !== RULE || message.severity !== 2 || message.fatal ||
          !Number.isSafeInteger(message.line) || message.line < 1) throw new Error("Unexpected ESLint rule or location");
      return { rule: RULE, line: message.line };
    });
    return { path, findings };
  }).sort((a, b) => compareCodeUnits(a.path, b.path));
  if (missing.size || report.some(row => row.findings.length > 0) !== (exitCode === 1)) {
    throw new Error("Missing ESLint row or exit status disagrees with findings");
  }
  return report;
}

/** @param {string[]} argv */
function main([cli, rootArg, ...paths]) {
  if (!cli || !isAbsolute(cli) || !rootArg || !paths.length || paths.length > 32) {
    throw new Error("Usage: node scripts/shared/probe-eslint-fixed-rule.mjs <absolute trusted installed ESLint CLI> <root> <1–32 relative .js files>");
  }
  const root = realpathSync(rootArg);
  const files = paths.map(path => {
    const file = resolveWithinRoot(root, path, { allowRoot: false });
    if (isAbsolute(path) || !file ||
        /[\[\]{}*?!]/u.test(file) || !file.endsWith(".js") || realpathSync(file) !== file || !statSync(file).isFile()) {
      throw new Error("Use regular JavaScript files with literal paths inside the fixture root");
    }
    return file;
  });
  if (new Set(files).size !== files.length) throw new Error("Repeated fixture file");
  // No project config, package runner, startup injection, fix, or network tool.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(systemroot|windir|temp|tmp|tmpdir)$/iu.test(key)));
  const options = { cwd: root, env, encoding: /** @type {const} */ ("utf8"), timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
  const version = spawnSync(process.execPath, [cli, "--version"], options);
  if (version.error || version.status !== 0 || version.stderr?.trim() || version.stdout.trim() !== VERSION) {
    throw new Error("Use the already installed ESLint " + VERSION + " qualified by this probe");
  }
  const run = spawnSync(process.execPath, [cli, "--no-config-lookup", "--no-ignore", "--no-inline-config",
    "--format", "json", "--rule", JSON.stringify({ [RULE]: "error" }), "--", ...files],
    options);
  if (run.error || run.signal || run.stderr?.trim()) throw new Error("ESLint did not return an unambiguous result");
  const rows = qualifyFixedRuleRows(run.stdout, run.status, files);
  process.stdout.write(JSON.stringify({
    profile: "fixed-eslint-no-debugger/v1", tool_version: VERSION, comparison_authority: "none",
    statement: "Developer probe only; cannot certify prior custom ESLint scans.",
    rows: rows.map(row => ({ ...row, path: relative(root, row.path).split(sep).join("/") })),
  }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`ESLint probe: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
