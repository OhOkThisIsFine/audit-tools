// sites-pinned: tests/dispatch-deadline-cycle2.test.mjs
// The agent-dispatch dispatch lane — a stdio MCP client to the agent-dispatch
// bridge (`node <repo>/src/cli.ts bridge`), ONE bridge process, N concurrent
// fire/wait pairs matched by JSON-RPC id.
//
// WHY THIS EXISTS (ledger 133f4f815b608ea4, owner decision 2026-09-03; ported
// off llm-relay by the switch/agent-dispatch lap, 2026-09-22). Best-lane
// selection never belonged to this module: it belonged to llm-relay's own
// `dispatch` tool, and llm-relay is retired. The successor is agent-dispatch's
// worker: the caller names a capability TIER, and LiteLLM auto-selects/fails
// over the concrete endpoint within it. The bridge's own stated system default
// tier is `litellm/medium` (agent-dispatch src/setup/opencode.ts workerConfig(),
// src/bridge/command.ts bridgeEnv()) — this module omits providerID/modelID on
// every call, so the sweep still names no model or tier and ledger
// 133f4f815b608ea4 stays literally true.
//
// TRANSPORT. The agent-dispatch bridge speaks JSON-RPC 2.0 (MCP) over stdio,
// one JSON message per line (CRLF tolerated). The surface used is
// `initialize`, `notifications/initialized`, and `tools/call` on
// `opencode_fire`, `opencode_wait`, and `opencode_job_cancel`.
//
// ⚠ ONE BRIDGE PROCESS, MANY CONCURRENT CALLS. The retired llm-relay client
// spawned one CHILD PER CONCURRENT DISPATCH because that server read stdin
// with `for await (chunk)`, one request at a time. The agent-dispatch bridge
// is different: it relays host lines to the wrapped worker process and only
// serializes its own WRITES (agent-dispatch src/bridge/command.ts: a `queue`
// wraps `child.stdin.write`, never a read), so replies can arrive out of
// order relative to sends. JSON-RPC responses are demultiplexed by id
// regardless of order — the same thing the retired client already assumed
// per child — so N concurrent `dispatch()` calls share ONE bridge process,
// proven by a test that answers two calls OUT OF ORDER.
//
// NO SERVER-SIDE TIMEOUT. `opencode_fire` has no timeout parameter and
// OpenCode enforces none on the task itself; the bridge clamps a single
// `opencode_wait` to at most 45 seconds (agent-dispatch src/bridge/proxy.ts
// MAX_WAIT_SECONDS). This module owns the ceiling: it polls `opencode_wait`
// with whatever time is left (never more than 45s per call). Initialization,
// fire and wait share the caller's deadline. A known job can get one bounded
// cancel after that deadline; only a terminal snapshot proves it is safe to
// release its checkout. Once fire may have been written, losing the reply is
// an unknown execution outcome, not a retryable transport failure.
//
// TERMINAL STATUSES. `completed`, `failed`, and `cancelled` are returned as
// terminal. `input_required` cannot happen for the `answer` agent (mode
// "answer", the default — every permission denied, agent-dispatch
// src/setup/opencode.ts). It CAN happen for `dispatch` (mode "agent"):
// DISPATCH_PERMISSION sets `question: 'allow'`, `external_directory: 'ask'`,
// and asks on `git commit`/`git push`/`rm -rf`/`Remove-Item -Recurse` among
// others — a caller in mode "agent" (only dispatch-load-flake-investigation.mjs
// today, against a disposable snapshot) can genuinely stall there. Handled the
// same way regardless: cancel the job and return it as a non-completed
// result, never leave a session waiting on a question nobody will answer.
//
// THE ANSWER. `structuredContent.text` is the tool's RENDERED text —
// Directory/Session/Job/Status lines, "Session completed.", then EVERY part's
// text including reasoning and a `_cost | tokens_` line from step-finish
// (opencode-mcp dist/helpers.js formatMessageResponse). The job's own answer
// is `structuredContent.result.parts`, filtered to `type === 'text'` and
// joined — reasoning and step-finish parts are excluded, so a `{` inside a
// reasoning part can never reach a caller's brace-scanning JSON salvage.
// `result` is the assistant message `{info, parts}` whenever no forced JSON
// schema was requested (dist/jobs.js observeSession(): `snapshot.result =
// assistant.info.structured ?? assistant`) — this module never requests one
// (see "DROPPED, NOT FAKED" below), so `result.parts` is always the shape to
// read.
//
// PROVENANCE. `lane` is `<providerID>/<modelID>` off `result.info`, when the
// job produced an assistant message; `agent-dispatch` otherwise (a job that
// never got a turn — a preflight rejection, an immediate failure). There is
// <!-- comment-citation-exempt: names the llm-relay field that was retired -->
// no `servedBy` any more: llm-relay's answer-mode deployment name has no
// opencode_fire/opencode_wait/opencode_check analogue.
//
// DROPPED, NOT FAKED. `schema` (forced JSON output), `maxTokens`, and
// `system` have no `opencode_fire` equivalent (opencode-mcp dist/job-contract.js
// dispatchShape: prompt, sessionId, title, providerID, modelID, variant,
// agent, directory, format — no maxTokens/system, and `format` needs an
// unverified StructuredOutput tool permission this module does not depend
// on). Callers may still pass them — accepted, silently ignored — because the
// schema already travels in the prompt text for a CLI-agent caller and the
// existing salvage-JSON parser in triage-backlog.mjs already tolerates
// unschemaed prose.
//
// A REPOSITORY-READING LANE RUNS IN A WORKTREE THIS MODULE OWNS (owner answer
// f78305ac08246ae5, 2026-09-24). A `mode: 'agent'` dispatch — the `dispatch`
// agent, which can read and write files — whose directory lies in a git
// repository never runs there. The helper adds a detached worktree of that
// directory's HEAD at `<container>-worktrees/<repo>/dispatch-lane-<pid>-<hex>`
// (the checkout `C:/Code/audit-tools` maps to `C:/Code-worktrees/audit-tools/
// ...`; `<repo>` is the MAIN checkout's name even when the caller sits in a
// linked worktree), points the job at the same subdirectory inside it, and
// removes it only when no fire was sent or a terminal job is confirmed.
// Before fire it locks the worktree with Git, so a later stale sweep cannot
// remove it if this process exits without confirming the outcome.
// A nested worktree is refused because it breaks outer test discovery.
// Consequences: the lane reads COMMITTED HEAD, never the
// caller's uncommitted edits, and its own writes are discarded; the caller's
// HEAD, index, branches and status are untouched (`--detach` creates no
// branch). The `answer` agent (every tool denied) and a directory outside git
// (a disposable snapshot) are passed through unchanged — neither can reach a
// checkout.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { processAlive } from './primitives.mjs';
import { resolveSpawn } from './spawn-shell.mjs';

/** The MCP revision this client requests; the server echoes it when it serves it. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

/** Ceiling on one `opencode_wait` call — the bridge's own clamp. */
const MAX_WAIT_SECONDS = 45;

/**
 * How long a wait that returned non-terminal WITHOUT using its full time
 * budget is retried after — upstream `opencode_wait`'s own default
 * `pollIntervalMs` (opencode-mcp dist/tools/workflow.js), a labelled existing
 * default rather than a number this module picked.
 */
const WAIT_RETRY_MS = 2_000;

/** How long `close()` gives the bridge to exit on stdin end before killing it. */
const CLOSE_GRACE_MS = 5_000;
const CANCEL_GRACE_MS = 1_500;
const WORKTREE_CLEANUP_MS = 1_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Statuses a poll stops on: an answer or an error exists, or input is needed. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'input_required']);

/** The transport died or refused: no answer exists, terminal or otherwise. */
export class DispatchLaneError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'DispatchLaneError';
  }
}

class DispatchDeadlineError extends DispatchLaneError {
  constructor(operation) {
    super('agent-dispatch deadline exceeded during ' + operation);
    this.name = 'DispatchDeadlineError';
  }
}

// Avoid Node's overflow-to-1ms behavior for large deadlines.
function deadlineTimer(deadline, expire) {
  let timer;
  function arm() {
    const left = deadline - performance.now();
    timer = setTimeout(
      () => performance.now() < deadline ? arm() : expire(),
      Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil(left))),
    );
  }
  arm();
  return () => clearTimeout(timer);
}

/**
 * The checkout every host entry on this machine runs (agent-dispatch
 * src/setup/hosts.ts hostEntries(): `process.execPath` + `<REPO_ROOT>/src/
 * cli.ts bridge`, and setup registers `REPO_ROOT`) — override with
 * `AGENT_DISPATCH_REPO` for another machine or a test fixture.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function agentDispatchRepo(env) {
  return env.AGENT_DISPATCH_REPO || 'C:/Code/agent-dispatch';
}

/**
 * Whether a Node version string satisfies agent-dispatch's `engines.node`
 * (`>=22.18`, package.json): its `src/cli.ts` entry runs unbuilt, and type
 * stripping for a `.ts` file needs that floor.
 *
 * @param {string} version `process.versions.node` shape: `MAJOR.MINOR.PATCH`
 */
export function satisfiesAgentDispatchNode(version) {
  const [major, minor] = String(version).split('.').map(Number);
  return Number.isFinite(major) && Number.isFinite(minor) && (major > 22 || (major === 22 && minor >= 18));
}

/**
 * Fail loudly before spawning anything: a missing checkout or an old Node
 * produces a MODULE_NOT_FOUND or a type-stripping error deep inside the
 * bridge's own stdout, not a message that names the fix. Skipped when the
 * caller supplies its own `command` (a test's fake bridge needs neither
 * check — see `openDispatchLane`).
 *
 * @param {string} repo
 */
function checkPreflight(repo) {
  const cli = join(repo, 'src', 'cli.ts');
  if (!existsSync(cli)) {
    throw new DispatchLaneError(
      `agent-dispatch checkout not found: ${cli} does not exist. Set AGENT_DISPATCH_REPO to the ` +
        `checkout, or run \`node <repo>/src/cli.ts status\` once one is configured.`,
    );
  }
  if (!satisfiesAgentDispatchNode(process.versions.node)) {
    throw new DispatchLaneError(
      `agent-dispatch needs Node >= 22.18 for its unbuilt .ts entry (this process runs ` +
        `${process.versions.node}).`,
    );
  }
}

/**
 * The answer: `result.parts` entries of type `text` only, concatenated.
 * Reasoning and step-finish parts are excluded — see the module header.
 *
 * @param {unknown} result
 */
export function extractAnswer(result) {
  const parts = result && typeof result === 'object' ? /** @type {any} */ (result).parts : undefined;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

/**
 * `name: message`. The assistant's own `.info.error` union carries `message`
 * directly on some members and `data.message` on others (OpenCode SDK
 * AssistantMessage['error']); a job-level `requestError()` shape carries
 * `message` directly. Try both before falling back to the whole value.
 *
 * @param {unknown} error
 */
function stringifyError(error) {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'string') return error;
  const e = /** @type {any} */ (error);
  const name = typeof e.name === 'string' ? e.name : 'Error';
  const message =
    typeof e.message === 'string' ? e.message : typeof e.data?.message === 'string' ? e.data.message : JSON.stringify(e);
  return `${name}: ${message}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// sites-pinned: tests/dispatch-deadline-cycle2.test.mjs
/** The name every helper-owned lane worktree carries; the pid is its owner. */
const LANE_WORKTREE_NAME = /^dispatch-lane-(\d+)-[0-9a-f]+$/;

/**
 * Run git synchronously. stdin is `ignore`d — nothing is fed to git, and a
 * piped stdin nobody writes is the hang the spawn conventions warn about.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeout]
 */
function git(args, cwd, timeout) {
  return spawnSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, killSignal: 'SIGKILL',
  });
}

const timeLeft = (deadline) => Math.max(0, Math.min(MAX_TIMER_MS, Math.ceil(deadline - performance.now())));

/** @param {string[]} args @param {string} cwd @param {number} [deadline] */
function gitOrThrow(args, cwd, deadline = Infinity) {
  const timeout = Number.isFinite(deadline) ? timeLeft(deadline) : undefined;
  if (timeout === 0) throw new DispatchDeadlineError('worktree setup');
  const r = git(args, cwd, timeout);
  if (r.status !== 0) {
    throw new DispatchLaneError(
      `git ${args.join(' ')} failed in ${cwd} (${r.error?.message ?? `exit ${r.status}`}): ${(r.stderr ?? '').trim()}`,
    );
  }
  return (r.stdout ?? '').trim();
}

/**
 * The repository a directory belongs to, or null when it is in none (or does
 * not exist).
 *
 * @param {string} directory
 * @param {number} deadline
 * @returns {{ mainTop: string, prefix: string, head: string } | null}
 */
function repositoryOf(directory, deadline) {
  if (!existsSync(directory)) return null;
  const timeout = timeLeft(deadline);
  if (!timeout) throw new DispatchDeadlineError('worktree setup');
  const probe = git(['rev-parse', '--is-inside-work-tree'], directory, timeout);
  if (probe.error) throw new DispatchLaneError('could not inspect the lane workspace: ' + probe.error.message);
  if (probe.status !== 0 || probe.stdout.trim() !== 'true') return null;
  const [commonDir, prefix] = gitOrThrow(
    ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-prefix'],
    directory, deadline,
  ).split(/\r?\n/);
  return { mainTop: dirname(resolve(commonDir)), prefix: prefix ?? '', head: gitOrThrow(['rev-parse', 'HEAD'], directory, deadline) };
}

/**
 * The directory every lane worktree of a repository lives in:
 * `<container>-worktrees/<repo>` beside the main checkout's container.
 *
 * @param {string} mainTop
 */
export function laneWorktreeContainer(mainTop) {
  return join(`${dirname(mainTop)}-worktrees`, basename(mainTop));
}

/**
 * The repository root nearest above `path`, or null. Walks the filesystem,
 * because the path need not exist yet.
 *
 * @param {string} path
 */
function enclosingRepository(path) {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Remove one lane worktree: git's own removal first, the directory and git's
 * stale record second, so a half-registered worktree still goes.
 *
 * @param {string} mainTop
 * @param {string} path
 */
function removeLaneWorktree(mainTop, path, deadline = performance.now() + WORKTREE_CLEANUP_MS, release = false) {
  // Only a helper-owned path under this repository's worktree container
  // can reach git removal or the recursive fallback.
  path = resolve(path);
  if (dirname(path) !== resolve(laneWorktreeContainer(mainTop)) || !LANE_WORKTREE_NAME.test(basename(path))) return;
  const clean = (args) => {
    const timeout = timeLeft(deadline);
    return timeout ? git(args, mainTop, timeout) : undefined;
  };
  if (release) clean(['worktree', 'unlock', path]);
  const removed = clean(['worktree', 'remove', '--force', path]);
  // A half-created worktree can be missing from Git's registry. Keep the
  // fallback bounded too; cleanup failure must not replay a confirmed job.
  const timeout = timeLeft(deadline);
  if (removed?.status !== 0 && timeout && existsSync(path)) {
    spawnSync(process.execPath, [
      '-e', 'require("node:fs").rmSync(process.argv[1], {recursive: true, force: true})', path,
    ], { timeout, killSignal: 'SIGKILL', stdio: 'ignore', windowsHide: true });
  }
  clean(['worktree', 'prune']);
}

/**
 * Remove every lane worktree of this repository whose owning process is gone —
 * the residue of a dispatch killed before its `finally` ran.
 *
 * @param {string} mainTop
 * @param {string} container
 */
export function sweepStaleLaneWorktrees(mainTop, container, deadline = performance.now() + WORKTREE_CLEANUP_MS) {
  if (!existsSync(container)) return;
  const stale = readdirSync(container).filter((name) => {
    const owner = LANE_WORKTREE_NAME.exec(name);
    return owner && !processAlive(Number(owner[1]));
  });
  if (!stale.length) return;
  // If Git cannot tell us which worktrees are protected, do not sweep.
  const timeout = timeLeft(deadline);
  if (!timeout) return;
  const listed = git(['worktree', 'list', '--porcelain', '-z'], mainTop, timeout);
  if (listed.status !== 0) return;
  const locked = new Set();
  const pathKey = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  let path;
  for (const entry of listed.stdout.split('\0')) {
    if (entry.startsWith('worktree ')) path = pathKey(entry.slice('worktree '.length));
    else if (path && (entry === 'locked' || entry.startsWith('locked '))) locked.add(path);
  }
  for (const name of stale) {
    if (performance.now() >= deadline) break;
    const path = resolve(container, name);
    if (!locked.has(pathKey(path))) removeLaneWorktree(mainTop, path, deadline);
  }
}

/**
 * Give a repository-reading dispatch its own worktree. Null when `directory`
 * is in no repository: nothing there is a checkout to protect.
 *
 * @param {string} directory
 * @param {number} deadline
 * @returns {{ path: string, directory: string, protect: () => void, remove: () => void } | null}
 */
function openLaneWorktree(directory, deadline) {
  const repo = repositoryOf(directory, deadline);
  if (repo === null) return null;
  const container = laneWorktreeContainer(repo.mainTop);
  const nesting = enclosingRepository(container);
  if (nesting !== null) {
    throw new DispatchLaneError(
      `refusing a lane worktree at ${container}: it lies inside the repository ${nesting}, and a nested ` +
        `worktree breaks that repository's test discovery.`,
    );
  }
  sweepStaleLaneWorktrees(repo.mainTop, container, Math.min(deadline, performance.now() + WORKTREE_CLEANUP_MS));
  const path = join(container, `dispatch-lane-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    gitOrThrow(['worktree', 'add', '--detach', path, repo.head], repo.mainTop, deadline);
  } catch (err) {
    removeLaneWorktree(repo.mainTop, path);
    throw err;
  }
  const inside = join(path, repo.prefix);
  return {
    path,
    directory: existsSync(inside) ? inside : path,
    protect: () => gitOrThrow(
      ['worktree', 'lock', '--reason', 'agent-dispatch execution may still use this checkout', path],
      repo.mainTop, deadline,
    ),
    remove: () => removeLaneWorktree(repo.mainTop, path, undefined, true),
  };
}

/**
 * One agent-dispatch bridge process with its handshake in flight.
 *
 * @param {{ command: string, args: string[], cwd: string, spawnImpl: typeof spawn,
 *   protocolVersion: string, onStderr: (chunk: string) => void }} opts
 */
function startBridge({ command, args, cwd, spawnImpl, protocolVersion, onStderr }) {
  const resolved = resolveSpawn(command, args);
  const child = spawnImpl(resolved.command, resolved.args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  /** @type {Map<number, { resolve: (msg: any) => void, reject: (err: Error) => void }>} */
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  /** @type {string | null} */
  let transportError = null;
  let childEnded = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim() === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Not protocol — a stray write.
      }
      const waiter = message && message.id !== undefined ? pending.get(message.id) : undefined;
      if (!waiter) continue; // A notification, or a reply nobody is waiting for.
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => onStderr(String(chunk)));

  const settle = (/** @type {string} */ reason) => {
    if (transportError !== null) return;
    transportError = reason;
    for (const waiter of pending.values()) waiter.reject(new DispatchLaneError(reason));
    pending.clear();
  };
  child.stdin.on('error', (err) => settle('agent-dispatch bridge stdin closed: ' + err.message));
  child.on('error', (err) => settle(`agent-dispatch bridge failed to start: ${err.message}`));
  const onChildEnd = (code, signal) => {
    childEnded = true;
    settle('agent-dispatch bridge exited (' + (signal ?? code) + ') before answering');
  };
  child.on('exit', onChildEnd);
  child.on('close', onChildEnd);

  const write = (/** @type {object} */ message) => {
    try {
      child.stdin.write(JSON.stringify(message) + '\n');
    } catch (err) {
      settle(`agent-dispatch bridge stdin closed: ${/** @type {any} */ (err)?.message ?? err}`);
    }
  };
  const request = (method, params, deadline, onSend, signal) =>
    new Promise((resolve, reject) => {
      const operation = params?.name ?? method;
      const timeout = () => new DispatchDeadlineError(operation);
      if (transportError !== null) return reject(new DispatchLaneError(transportError));
      if (signal?.aborted || performance.now() >= deadline) return reject(timeout());
      const id = nextId++;
      const release = () => {
        pending.delete(id);
        stopTimer();
        signal?.removeEventListener('abort', expire);
      };
      const expire = () => {
        release();
        reject(timeout());
      };
      const stopTimer = Number.isFinite(deadline) ? deadlineTimer(deadline, expire) : () => {};
      signal?.addEventListener('abort', expire, { once: true });
      pending.set(id, {
        resolve: (msg) => {
          if (performance.now() >= deadline) return expire();
          release();
          resolve(msg);
        },
        reject: (err) => { release(); reject(err); },
      });
      onSend?.();
      write({ jsonrpc: '2.0', id, method, params });
    });

  // Share one handshake. A short concurrent caller cannot cancel a longer
  // one, but the handshake is abandoned when nobody is left waiting for it.
  let initialization;
  let initialized = false;
  let waiting = 0;
  const controller = new AbortController();
  async function ready(deadline) {
    if (transportError !== null) throw new DispatchLaneError(transportError);
    if (initialized) return;
    if (performance.now() >= deadline) throw new DispatchDeadlineError('initialize');
    initialization ??= request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'audit-tools dispatch lane', version: '1' },
    }, Infinity, undefined, controller.signal).then((reply) => {
      if (reply.error) throw new DispatchLaneError('initialize refused: ' + reply.error.message);
      initialized = true;
      write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    });
    waiting++;
    try {
      await new Promise((resolve, reject) => {
        const stop = deadlineTimer(deadline, () => reject(new DispatchDeadlineError('initialize')));
        initialization.then(
          () => { stop(); resolve(undefined); },
          (err) => { stop(); reject(err); },
        );
      });
    } finally {
      if (--waiting === 0 && !initialized) controller.abort();
    }
  }

  return {
    request,
    ready,
    close: () =>
      new Promise((resolve) => {
        if (childEnded) return resolve(undefined);
        const finish = () => {
          clearTimeout(timer);
          child.off('exit', finish);
          child.off('close', finish);
          resolve(undefined);
        };
        const timer = setTimeout(() => {
          settle('agent-dispatch bridge closed by its owner');
          try { child.kill('SIGKILL'); } catch {}
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish();
        }, CLOSE_GRACE_MS);
        child.once('exit', finish);
        child.once('close', finish);
        try { child.stdin.end(); } catch {}
      }),
  };
}

/**
 * Call one MCP tool and return its `structuredContent`.
 *
 * @param {ReturnType<typeof startBridge>} bridge
 * @param {'opencode_fire' | 'opencode_wait' | 'opencode_job_cancel'} name
 * @param {Record<string, unknown>} args
 * @param {number} deadline monotonic milliseconds
 * @param {() => void} [onSend] marks a fire as potentially accepted
 */
async function callTool(bridge, name, args, deadline, onSend) {
  const reply = await bridge.request('tools/call', { name, arguments: args }, deadline, onSend);
  if (reply.error) {
    throw new DispatchLaneError(`${name} refused: ${reply.error.message}`);
  }
  const sc = reply.result?.structuredContent;
  if (!sc || typeof sc.status !== 'string') {
    throw new DispatchLaneError(`${name} returned no status: ${JSON.stringify(reply.result ?? null).slice(0, 300)}`);
  }
  return sc;
}

// sites-pinned: tests/dispatch-deadline-cycle2.test.mjs
//   The fixture drives deadline cancellation with and without a reply.
/**
 * Cancel a job. A failed cancel throws a `DispatchLaneError` whose text names
 * the job and `failedWhat`, the phrase that says which cancel failed.
 *
 * @param {ReturnType<typeof startBridge>} bridge
 * @param {string} jobId
 * @param {string} failedWhat
 */
async function cancelJob(bridge, jobId, failedWhat) {
  try {
    return await callTool(bridge, 'opencode_job_cancel', { jobId }, performance.now() + CANCEL_GRACE_MS);
  } catch (err) {
    throw new DispatchLaneError(
      `opencode_job_cancel for ${jobId} ${failedWhat}: ${/** @type {any} */ (err)?.message ?? err}`,
      { cause: err },
    );
  }
}

async function pollUntilTerminal(bridge, jobId, deadline, waitRetryMs) {
  while (performance.now() < deadline) {
    let sc;
    try {
      sc = await callTool(bridge, 'opencode_wait', {
        jobId,
        timeoutSeconds: Math.min(MAX_WAIT_SECONDS, Math.max(0, (deadline - performance.now()) / 1000)),
      }, deadline);
    } catch (err) {
      if (err instanceof DispatchDeadlineError) break;
      throw err;
    }
    if (TERMINAL_STATUSES.has(sc.status)) return sc;
    if (sc.timedOut !== true) await sleep(Math.max(0, Math.min(waitRetryMs, deadline - performance.now())));
  }
  return null;
}

/**
 * @param {any} sc terminal structuredContent
 * @returns {{ raw: string, status: string, lane: string, error: string | undefined, jobId?: string, checkout?: string }}
 */
function finalize(sc) {
  const info = sc?.result && typeof sc.result === 'object' ? sc.result.info : undefined;
  const lane =
    info && typeof info.providerID === 'string' && typeof info.modelID === 'string'
      ? `${info.providerID}/${info.modelID}`
      : 'agent-dispatch';
  return {
    raw: extractAnswer(sc?.result),
    status: typeof sc?.status === 'string' ? sc.status : 'unknown',
    lane,
    error: stringifyError(sc?.error),
    ...(typeof sc?.jobId === 'string' ? { jobId: sc.jobId } : {}),
    ...(typeof sc?.checkout === 'string' ? { checkout: sc.checkout } : {}),
  };
}

/**
 * Open a dispatch lane: ONE agent-dispatch bridge process, shared by every
 * concurrent `dispatch()` call on this lane (matched by JSON-RPC id — see the
 * module header for why one process is enough).
 *
 * @param {object} [opts]
 * @param {number} [opts.size] accepted and IGNORED — kept only so existing
 *   callers written for the one-child-per-slot pool still type-check.
 *   Concurrency is now N pending requests on one shared bridge process.
 * @param {string} [opts.command] the bridge executable (default `process.execPath`)
 * @param {string[]} [opts.args] its arguments (default `[<repo>/src/cli.ts, 'bridge']`)
 * @param {string} [opts.cwd] working directory for the bridge process AND the
 *   default `directory` a dispatch names when it supplies none of its own
 * @param {typeof spawn} [opts.spawnImpl] test seam
 * @param {string} [opts.protocolVersion]
 * @param {(chunk: string) => void} [opts.onStderr] the bridge's stderr (default: forwarded)
 * @param {NodeJS.ProcessEnv} [opts.env] resolves `AGENT_DISPATCH_REPO` when
 *   `command`/`args` are not supplied (default `process.env`)
 * @param {number} [opts.waitRetryMs] test seam for `WAIT_RETRY_MS` (default
 *   2000, upstream `opencode_wait`'s own poll interval — see the module header)
 */
export function openDispatchLane({
  size: _size = 1,
  command,
  args,
  cwd = process.cwd(),
  spawnImpl = spawn,
  protocolVersion = MCP_PROTOCOL_VERSION,
  onStderr = (chunk) => process.stderr.write(chunk),
  env = process.env,
  waitRetryMs = WAIT_RETRY_MS,
} = {}) {
  const usingDefaultCommand = command === undefined && args === undefined;
  const repo = agentDispatchRepo(env);
  if (usingDefaultCommand) checkPreflight(repo);
  const resolvedCommand = command ?? process.execPath;
  const resolvedArgs = args ?? [join(repo, 'src', 'cli.ts'), 'bridge'];

  const bridge = startBridge({
    command: resolvedCommand,
    args: resolvedArgs,
    cwd,
    spawnImpl,
    protocolVersion,
    onStderr,
  });

  return {
    /**
     * Dispatch ONE task and return its terminal answer.
     *
     * @param {string} task
     * @param {object} opts
     * @param {number} opts.timeoutMs REQUIRED — client-owned ceiling on the
     *   whole call; agent-dispatch enforces none of its own (see the module
     *   header). Label each caller value with where it came from.
     * @param {'answer' | 'agent'} [opts.mode] default `answer` → the Track A
     *   `answer` agent (every tool denied); `agent` → the full `dispatch` agent.
     * @param {string} [opts.cwd] agent-dispatch's `directory` for this call
     *   (default the lane's own `cwd`)
     * @param {string} [opts.system] unused — see "DROPPED, NOT FAKED" above;
     *   accepted so an existing caller's option object still type-checks.
     * @param {Record<string, unknown>} [opts.schema] unused — see above.
     * @param {number} [opts.maxTokens] unused — see above.
     * @returns {Promise<ReturnType<typeof finalize>>}
     */
    async dispatch(task, opts) {
      if (!Number.isFinite(opts?.timeoutMs) || !(opts.timeoutMs > 0)) {
        throw new DispatchLaneError('dispatch requires opts.timeoutMs (agent-dispatch enforces no job timeout of its own)');
      }
      const deadline = performance.now() + opts.timeoutMs;
      await bridge.ready(deadline);
      const agent = opts.mode === 'agent' ? 'dispatch' : 'answer';
      const requested = resolve(opts.cwd ?? cwd);
      // sites-pinned: tests/dispatch-deadline-cycle2.test.mjs
      const worktree = agent === 'dispatch' ? openLaneWorktree(requested, deadline) : null;
      let fireSent = false;
      let terminal = false;
      let jobId;
      try {
        worktree?.protect();
        let sc = await callTool(bridge, 'opencode_fire', {
          prompt: task,
          agent,
          directory: worktree?.directory ?? requested,
          // providerID/modelID intentionally omitted - see the module header.
        }, deadline, () => { fireSent = true; });
        jobId = typeof sc.jobId === 'string' && sc.jobId ? sc.jobId : undefined;
        if (!TERMINAL_STATUSES.has(sc.status)) {
          if (!jobId) throw new DispatchLaneError('fire reply did not identify the job');
          sc = await pollUntilTerminal(bridge, jobId, deadline, waitRetryMs);
        }
        if (sc === null || sc.status === 'input_required') {
          const timedOut = sc === null;
          if (!jobId) throw new DispatchLaneError('cannot cancel without a job ID');
          sc = await cancelJob(bridge, jobId, timedOut ? 'failed after its deadline' : '(input_required) failed');
          if (!TERMINAL_STATUSES.has(sc.status) || sc.status === 'input_required') {
            throw new DispatchLaneError('cancel reported ' + sc.status + ', not a terminal outcome');
          }
          if (timedOut && sc.status === 'cancelled') {
            sc = { ...sc, status: 'timed_out', error: 'job ' + jobId + ' exceeded its timeout; cancel reported cancelled' };
          } else if (!timedOut && sc.status === 'cancelled' && sc.error == null) {
            sc = { ...sc, error: 'job ' + jobId + ' asked for input; a headless sweep cannot answer it - cancelled' };
          }
        }
        terminal = true;
        return finalize({ ...sc, jobId: jobId ?? sc.jobId });
      } catch (err) {
        if (!fireSent) throw err;
        const identity = jobId ? ' for job ' + jobId : '';
        return finalize({
          status: 'unknown',
          jobId,
          checkout: worktree?.path,
          error: 'execution outcome unknown' + identity + ': ' + (/** @type {{ message?: unknown } | null | undefined} */ (err)?.message ?? err),
        });
      } finally {
        if (!fireSent || terminal) worktree?.remove();
      }
    },

    /** End the bridge process; the lane is unusable afterwards. */
    async close() {
      await bridge.close();
    },
  };
}
