// sites-pinned: tests/shared/triage-lane-health.test.ts
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
// with whatever time is left (never more than 45s per call), and on ITS OWN
// `timeoutMs` deadline it calls `opencode_job_cancel` and RETURNS rather than
// throwing — a throw is exactly what `lane-dispatch.mjs` retries once, and a
// timeout must never run the same call twice. The RETURN is usually a
// non-completed result (status `timed_out`, naming the job and the elapsed
// time), but not always: upstream `JobService.cancel()` returns the terminal
// snapshot UNCHANGED when the job already finished between the last wait and
// the cancel call, so a completed/failed answer that lands exactly there is
// returned as-is — never discarded and relabeled `timed_out`. A wait that
// comes back non-terminal WITHOUT using its full time budget (e.g. a
// transient worker-read fault reporting `unknown` at once — opencode-mcp dist/
// tools/workflow.js waitForSnapshot()'s catch path) is retried after upstream
// opencode_wait's own default poll interval (2000 ms), not in a tight loop.
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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * The checkout every host entry on this machine runs (agent-dispatch
 * src/setup/hosts.ts hostEntries(): `process.execPath` + `<REPO_ROOT>/src/
 * cli.ts bridge`, and setup registers `REPO_ROOT`) — override with
 * `AGENT_DISPATCH_REPO` for another machine or a test fixture.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function agentDispatchRepo(env) {
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
 * produces a `MODULE_NOT_FOUND` or a type-stripping error deep inside the
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
  let exited = null;

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
    if (exited !== null) return;
    exited = reason;
    for (const waiter of pending.values()) waiter.reject(new DispatchLaneError(reason));
    pending.clear();
  };
  child.on('error', (err) => settle(`agent-dispatch bridge failed to start: ${err.message}`));
  child.on('exit', (code, signal) => settle(`agent-dispatch bridge exited (${signal ?? code}) before answering`));

  const write = (/** @type {object} */ message) => {
    try {
      child.stdin.write(JSON.stringify(message) + '\n');
    } catch (err) {
      settle(`agent-dispatch bridge stdin closed: ${/** @type {any} */ (err)?.message ?? err}`);
    }
  };
  const request = (/** @type {string} */ method, /** @type {unknown} */ params) =>
    new Promise((resolve, reject) => {
      if (exited !== null) {
        reject(new DispatchLaneError(exited));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      write({ jsonrpc: '2.0', id, method, params });
    });

  const ready = request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'audit-tools dispatch lane', version: '1' },
  }).then((reply) => {
    if (reply.error) throw new DispatchLaneError(`initialize refused: ${reply.error.message}`);
    write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    return reply.result;
  });
  // A handshake that fails is reported by the first dispatch, not as an
  // unhandled rejection in between.
  ready.catch(() => {});

  return {
    request,
    ready,
    isDead: () => exited !== null,
    close: () =>
      new Promise((resolve) => {
        if (exited !== null) {
          resolve(undefined);
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolve(undefined);
        }, CLOSE_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
        try {
          child.stdin.end(); // The bridge treats stdin end as its own end of life.
        } catch {}
      }),
  };
}

/**
 * Call one MCP tool and return its `structuredContent`.
 *
 * @param {ReturnType<typeof startBridge>} bridge
 * @param {'opencode_fire' | 'opencode_wait' | 'opencode_job_cancel'} name
 * @param {Record<string, unknown>} args
 */
async function callTool(bridge, name, args) {
  const reply = await bridge.request('tools/call', { name, arguments: args });
  if (reply.error) {
    throw new DispatchLaneError(`${name} refused: ${reply.error.message}`);
  }
  const sc = reply.result?.structuredContent;
  if (!sc || typeof sc.status !== 'string') {
    throw new DispatchLaneError(`${name} returned no status: ${JSON.stringify(reply.result ?? null).slice(0, 300)}`);
  }
  return sc;
}

/**
 * Poll a job to a terminal status, respecting the CALLER's `deadline` — not
 * the bridge's own 45-second-per-call clamp. On deadline, cancel and RETURN
 * rather than throwing (see the module header) — usually a `timed_out`
 * result, but the cancel snapshot's own completed/failed answer when the job
 * finished right at the deadline.
 *
 * @param {ReturnType<typeof startBridge>} bridge
 * @param {string} jobId
 * @param {number} deadline epoch ms
 * @param {number} startedAt epoch ms
 * @param {number} waitRetryMs test seam for `WAIT_RETRY_MS` — see `openDispatchLane`
 */
async function pollUntilTerminal(bridge, jobId, deadline, startedAt, waitRetryMs) {
  for (;;) {
    if (Date.now() >= deadline) {
      let cancelled;
      try {
        cancelled = await callTool(bridge, 'opencode_job_cancel', { jobId });
      } catch (err) {
        // The cancel itself failing after a deadline is a transport-level
        // fault, not an ordinary timeout: throw, so the driver's one retry
        // applies (a plain timed-out RETURN never reaches that retry).
        throw new DispatchLaneError(
          `opencode_job_cancel for ${jobId} failed after its deadline: ${/** @type {any} */ (err)?.message ?? err}`,
          { cause: err },
        );
      }
      // Upstream JobService.cancel() returns the TERMINAL snapshot unchanged
      // when the job already finished between the last wait and this cancel
      // call — a real completed/failed answer must never be discarded and
      // relabeled timed_out just because it arrived on the cancel reply
      // rather than a wait reply.
      if (cancelled.status === 'completed' || cancelled.status === 'failed') return cancelled;
      // The error names what the cancel reply itself reported, so a reader
      // (and a test) can see whether the cancel took effect.
      return {
        ...cancelled,
        status: 'timed_out',
        error: `job ${jobId} still running after ${Date.now() - startedAt} ms, past its timeout — cancel reported ${cancelled.status}`,
      };
    }
    const secondsLeft = Math.max(0, (deadline - Date.now()) / 1000);
    const sc = await callTool(bridge, 'opencode_wait', {
      jobId,
      timeoutSeconds: Math.min(MAX_WAIT_SECONDS, secondsLeft),
    });
    if (TERMINAL_STATUSES.has(sc.status)) return sc;
    if (sc.timedOut !== true) await sleep(waitRetryMs);
  }
}

/**
 * `input_required` cannot happen for the `answer` agent, but CAN for
 * `dispatch` (mode "agent" — see the module header): handled rather than
 * ignored, cancel the job and return it as a non-completed result instead of
 * leaving a session waiting on a question nobody will answer.
 *
 * @param {ReturnType<typeof startBridge>} bridge
 * @param {string} jobId
 */
async function cancelInputRequired(bridge, jobId) {
  let cancelled;
  try {
    cancelled = await callTool(bridge, 'opencode_job_cancel', { jobId });
  } catch (err) {
    throw new DispatchLaneError(
      `opencode_job_cancel for ${jobId} (input_required) failed: ${/** @type {any} */ (err)?.message ?? err}`,
      { cause: err },
    );
  }
  return {
    ...cancelled,
    error: cancelled.error ?? `job ${jobId} asked for input; a headless sweep cannot answer it — cancelled`,
  };
}

/**
 * @param {any} sc terminal structuredContent
 * @returns {{ raw: string, status: string, lane: string, error: string | undefined }}
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
     * @returns {Promise<{ raw: string, status: string, lane: string, error: string | undefined }>}
     */
    async dispatch(task, opts) {
      if (typeof opts?.timeoutMs !== 'number' || !(opts.timeoutMs > 0)) {
        throw new DispatchLaneError('dispatch requires opts.timeoutMs (agent-dispatch enforces no job timeout of its own)');
      }
      await bridge.ready;
      const startedAt = Date.now();
      const deadline = startedAt + opts.timeoutMs;
      const agent = opts.mode === 'agent' ? 'dispatch' : 'answer';
      let sc = await callTool(bridge, 'opencode_fire', {
        prompt: task,
        agent,
        directory: opts.cwd ?? cwd,
        // providerID/modelID intentionally omitted — see the module header.
      });
      if (!TERMINAL_STATUSES.has(sc.status)) {
        sc = await pollUntilTerminal(bridge, sc.jobId, deadline, startedAt, waitRetryMs);
      }
      if (sc.status === 'input_required') {
        sc = await cancelInputRequired(bridge, sc.jobId);
      }
      return finalize(sc);
    },

    /** End the bridge process; the lane is unusable afterwards. */
    async close() {
      await bridge.close();
    },
  };
}
