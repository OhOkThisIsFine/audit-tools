import { admitRemediationDirtyBaseline } from "../state/dirtyBaseline.js";
// sites-pinned: tests/remediate/final-acceptance-window.test.ts
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { headCommit, isAdmittedProjectTestCommand, parseCommandString, runTrackedAsync, type RunLogger } from "audit-tools/shared";
import { nativeCloseContractScripts, nativeGuardAlias, worktreeContentId } from "../steps/gateCommands.js";
import type { RemediationState } from "../state/store.js";
import type { OrchestratorOptions } from "../types/options.js";
import { isVerifiedCompleteStatus } from "../state/itemStatus.js";
import {
  finalGateDisabledReason,
  runToolOwnedFinalGate,
  recordFinalGateOutcome,
  writeFinalGateRedRecord,
  type ToolOwnedFinalGateResult,
} from "../steps/finalGate.js";

export interface CombinedTestResult {
  /**
   * Whether a suite actually ran. `false` means `plan.test_command` was never
   * configured — a NEVER-RAN outcome, structurally distinct from `passed`, so
   * a caller can no longer mistake "nothing ran" for "a real pass" (the
   * vacuous-pass defect: previously `passed:true` alone claimed a real result
   * even for an unrun, unconfigured suite).
   */
  ran: boolean;
  passed: boolean;
  duration_ms: number;
  suite_name?: string;
  /** Tail of combined stdout/stderr captured on failure (empty on pass). */
  output: string;
  /** Observed child status, retained when this operation also supplies the floor. */
  exit_code?: number | null;
  executed_command?: string;
}

const DEFAULT_CLOSE_TEST = "npm test";
const NATIVE_CLOSE_LEAF = ["npm", "run", "test:built"];
const NATIVE_CLOSE_DEADLINE_MS = 3_600_000;

const DEFAULT_NPM_SETTINGS = [
  ["script-shell", "null"], ["ignore-scripts", "false"], ["workspace", ""],
  ["workspaces", "null"], ["include-workspace-root", "false"], ["global", "false"],
  ["node-options", "null"], ["location", "user"],
] as const;

// Ask the same npm executable at the same cwd; guessing rc-file locations
// misses global, redirected and layered configuration. Unknown output declines reuse.
async function npmExecutionContext(root: string): Promise<string | undefined> {
  try {
    const env = Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b));
    if (env.some(([name, value]) => value && /^(node_(options|path)|npm_config_prefix)$/i.test(name))) return;
    const keys = DEFAULT_NPM_SETTINGS.map(([key]) => key);
    const result = await runTrackedAsync(["npm", "config", "get", ...keys], { cwd: root, timeout: 10_000 });
    if (result.status !== 0 || result.error || result.signal) return;
    const expected = DEFAULT_NPM_SETTINGS.map(([key, value]) => `${key}=${value}`).join("\n");
    if (result.stdout.trim().replaceAll("\r\n", "\n") !== expected) return;
    return createHash("sha256").update(JSON.stringify([env, expected])).digest("hex");
  } catch {
    return undefined;
  }
}

function within(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/**
 * Git binds source bytes. Inspect ignored runtime trees separately: read the
 * actual built bytes, and use inode/version metadata for the installation so
 * we do not reopen every installed file three times. Changes to the contents,
 * modes, names or targets of installed files invalidate the observation.
 */
async function nativeCloseInputs(root: string, npmContext: string): Promise<string | undefined> {
  try {
    const [tree, head, canonical] = await Promise.all([worktreeContentId(root), headCommit(root), realpath(root)]);
    if (!tree || !head) return;
    const hash = createHash("sha256").update(JSON.stringify([canonical, tree, head, npmContext]));
    async function walk(path: string, key: string, installation?: string): Promise<string | undefined> {
      const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const subtree = createHash("sha256").update(key);
      // Batch sibling probes to keep Windows filesystem round trips bounded.
      for (let offset = 0; offset < entries.length; offset += 24) {
        const results = await Promise.all(entries.slice(offset, offset + 24).map(async entry => {
          const child = join(path, entry.name);
          if (entry.isDirectory()) return walk(child, entry.name, installation);
          const info = await lstat(child, { bigint: true });
          const identity = JSON.stringify([entry.name, ...[info.dev, info.ino, info.size, info.mode, info.ctimeNs, info.mtimeNs].map(String)]);
          if (entry.isSymbolicLink() && installation) {
            const target = await realpath(child);
            return within(installation, target) ? identity + target : undefined;
          }
          if (!entry.isFile() || !info.isFile()) return undefined;
          return installation ? identity : createHash("sha256").update(identity).update(await readFile(child)).digest("hex");
        }));
        for (const result of results) {
          if (result === undefined) return;
          subtree.update(JSON.stringify(result));
        }
      }
      return subtree.digest("hex");
    }
    const built = join(canonical, "dist");
    if (!(await lstat(built)).isDirectory()) return;
    const deps = await realpath(join(canonical, "node_modules"));
    const results = await Promise.all([
      walk(built, "dist"), walk(deps, "node_modules", deps),
      walk(join(canonical, "tests"), "tests"), walk(join(canonical, "scripts"), "scripts"),
    ]);
    if (results.some(result => result === undefined)) return;
    return hash.update(JSON.stringify([deps, results])).digest("hex");
  } catch {
    return undefined;
  }
}

/** No affirmative execution from a spawn/owner error with no child verdict. */
export function observedNativeCloseLeaf(result: Pick<Awaited<ReturnType<typeof runTrackedAsync>>, "status" | "signal">): boolean {
  return typeof result.status === "number" || Boolean(result.signal);
}

/**
 * A close owns ONE final acceptance window, after every host-input pause.
 * The floor and combined suite are requirements, not independent reasons to
 * spawn the same terminal unit operation. That operation runs through the
 * suite's stricter shape/admission path, with the same root, scrubbed host
 * environment and one-hour bound as the floor. No earlier result is consumed.
 *
 * Per-item, phase-boundary, analyzer, e2e and landing checks are different
 * operations. In particular this is not a command cache, even within a call:
 * only the planned terminal floor slot can discharge both labels. The exact
 * native advisory alias may subsequently cite that observation, never a prior attempt.
 */
export async function runCloseAcceptance(params: {
  state: RemediationState;
  options: OrchestratorOptions;
  runCombined: () => Promise<CombinedTestResult>;
  runLogger?: RunLogger;
}): Promise<{ gate?: ToolOwnedFinalGateResult; combinedTest?: CombinedTestResult; recheckNativeGuard?: () => Promise<boolean> }> {
  const { state, options, runCombined, runLogger } = params;
  admitRemediationDirtyBaseline(state);
  const scope = "all-terminal final gate";
  const disabledReason = finalGateDisabledReason(options) ??
    (Object.values(state.items ?? {}).some(item => isVerifiedCompleteStatus(item.status))
      ? null : "no verified-complete items to validate (nothing resolved)");
  if (disabledReason !== null) {
    await recordFinalGateOutcome({
      artifactsDir: options.artifactsDir, state, scope, gateKey: "tool_owned_final_gate", logPhase: "close", runLogger,
      outcome: "disabled", passed: false, commandsRun: 0, reason: disabledReason,
    });
    return {};
  }

  const testCommand = state.plan?.test_command;
  const combinedArgv = testCommand ? parseCommandString(testCommand) : undefined;
  const startedAt = Date.now();
  let combinedTest: CombinedTestResult | undefined;
  let recheckNativeGuard: (() => Promise<boolean>) | undefined;
  const nativeContext = !options.finalGateRunner &&
    state.plan?.test_command_source === "project_facts" && testCommand === DEFAULT_CLOSE_TEST &&
    nativeCloseContractScripts(options.root) ? await npmExecutionContext(options.root) : undefined;
  runLogger?.event({ phase: "close", kind: "executor_start", obligation: state.status, note: "tool_owned_final_gate" });
  const gate = await runToolOwnedFinalGate(options.root, {
    runner: options.finalGateRunner,
    testCommand: state.plan?.test_command_source !== "project_facts" ? combinedArgv : undefined,
    ...(nativeContext ? { nativeCloseUnit: async () => {
      const root = options.root;
      if (!nativeCloseContractScripts(root) || await npmExecutionContext(root) !== nativeContext ||
          !isAdmittedProjectTestCommand(["npm", "test"], root)) return;
      const before = await nativeCloseInputs(root, nativeContext);
      if (!before) return;
      return {
        argv: [...NATIVE_CLOSE_LEAF],
        execute: async (argv, cwd) => {
          const started = Date.now();
          const result = await runTrackedAsync(argv, { cwd, windowsHide: true, timeout: NATIVE_CLOSE_DEADLINE_MS });
          const ran = observedNativeCloseLeaf(result);
          const green = result.status === 0 && !result.error && result.signal == null;
          const sameInputs = async () => await npmExecutionContext(root) === nativeContext &&
            await nativeCloseInputs(root, nativeContext) === before &&
            nativeCloseContractScripts(root) && isAdmittedProjectTestCommand(["npm", "test"], root);
          const passed = green && await sameInputs();
          const output = passed ? "" : green
            ? "The native contract suite changed its bound candidate, runtime or npm inputs; no green verdict was reused."
            : [result.stdout, result.stderr, result.error?.message, result.signal].filter(Boolean).join("\n").slice(-4000);
          combinedTest = {
            ran, passed, output, suite_name: DEFAULT_CLOSE_TEST,
            ...(ran ? { executed_command: argv.join(" ") } : {}),
            duration_ms: Date.now() - started, exit_code: result.status,
          };
          if (passed && nativeGuardAlias(root)) {
            recheckNativeGuard = async () => await sameInputs() && nativeGuardAlias(root);
          }
          return { status: passed ? 0 : result.status === 0 ? null : result.status, stderr: output, ran };
        },
      };
    } } : {}),
    ...(combinedArgv ? {
      terminalUnit: {
        argv: combinedArgv,
        execute: async () => {
          // Admission is evaluated HERE, after builds/checks that can mutate
          // declarations. A refusal is a floor failure, never an enabled pass.
          combinedTest = await runCombined();
          return {
            // Admission/timeouts may refuse a nominal zero. Never turn that
            // into green, and never replace a real nonzero exit with a guess.
            status: combinedTest.passed ? 0 : combinedTest.exit_code === 0 ? null : combinedTest.exit_code ?? null,
            stderr: combinedTest.output, ran: combinedTest.ran,
          };
        },
      },
    } : {}),
  });
  const commandsRun = gate.results.filter(result => result.ran !== false).length;
  await recordFinalGateOutcome({
    artifactsDir: options.artifactsDir, state, scope, gateKey: "tool_owned_final_gate", logPhase: "close", runLogger,
    outcome: gate.outcome, passed: gate.passed, commandsRun,
    durationMs: Date.now() - startedAt,
    ...(gate.scoped_out ? { reason: "no executable verification command declared; operator command required" } : {}),
  });
  if (!gate.passed) {
    await writeFinalGateRedRecord(options.artifactsDir, scope, gate.results.find(result => !result.passed), { root: options.root, state });
  }
  return { gate, ...(combinedTest ? { combinedTest } : {}), ...(recheckNativeGuard ? { recheckNativeGuard } : {}) };
}
