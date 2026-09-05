// The llm-relay dispatch lane — a stdio MCP client to `llm-relay mcp`, ONE
// answer per call.
//
// WHY THIS EXISTS (ledger 133f4f815b608ea4, owner decision 2026-09-03). The
// leg-2 sweep used to NAME a model target: it read the relay's /v1/models
// roster and picked an alias, and when the alias it wanted was absent it fell
// back to the roster's first entry — the one passthrough that needs a real API
// key — and died 401 with zero entries attempted while four free pool lanes sat
// unused. Best-lane selection belongs to llm-relay (owner answer P49): this
// module hands each task to the relay's own `dispatch` tool and reads back the
// answer plus the lane that produced it. Nothing here chooses, ranks, or names
// a model.
//
// TRANSPORT. `llm-relay mcp` speaks JSON-RPC 2.0 over stdio, one JSON message
// per line (CRLF tolerated). The surface used is `initialize`,
// `notifications/initialized`, and `tools/call` on `dispatch`. That is four
// message shapes over newline-delimited JSON — the same "own only the tiny
// bit" call llm-relay itself made when it hand-rolled the server side.
//
// ⚠ ONE CHILD ANSWERS ONE REQUEST AT A TIME. The server reads stdin with
// `for await (chunk) { await ingest(chunk) }`, so a second request written
// while the first is in flight is not even read until the first answers. A
// caller that wants N concurrent dispatches therefore gets a POOL of N
// children (`size`), each with its own handshake, handed out to idle slots.
//
// ONE CALL, ONE TERMINAL ANSWER. The server's `dispatch` blocks for `waitMs`
// and then hands back a job handle to poll. This lane never polls: it sets
// `waitMs` past `timeoutMs`, so every call returns a TERMINAL job — completed,
// failed, timed_out — and the caller decides what a non-completed status
// means. A terminal failure is RETURNED, not thrown, so the driver can still
// record what the lane did (finish reason, output size) on the error row; only
// a transport death — the child exited, the RPC itself was refused — throws.
//
// PROVENANCE RIDES EVERY ANSWER. The relay's rule is that dispatch "never
// pretends a CLI answered": the result header names the lane and, in answer
// mode, the deployment that served it. Both are parsed out and returned so a
// record can say which lane classified it.
import { spawn } from 'node:child_process';
import { platformCommand } from './smoke-process.mjs';
import { resolveSpawn } from './spawn-shell.mjs';

/** The MCP revision this client requests; the server echoes it when it serves it. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

/** Ceiling on one dispatch when the caller names none — the relay's own default. */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;

/** How far past `timeoutMs` the server's wait is set, so a call never returns a running job. */
const WAIT_GRACE_MS = 5_000;

/** How long `close()` gives a child to exit on stdin end before killing it. */
const CLOSE_GRACE_MS = 5_000;

/** The transport died or refused: no answer exists, terminal or otherwise. */
export class DispatchLaneError extends Error {
  /**
   * @param {string} message
   * @param {{ header?: Record<string, string>, body?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'DispatchLaneError';
    this.header = details.header ?? {};
    this.body = details.body ?? '';
  }
}

/**
 * Split a `dispatch` result text into its provenance header and the answer body.
 *
 * The server renders `key: value` lines (job, lane, status, elapsed, exit,
 * error, served-by, …), a blank line, then the lane's output verbatim. The
 * `lane:` value is `<id>` or `<id> (<spec>)`; both halves are returned.
 *
 * @param {string} text
 * @returns {{ header: Record<string, string>, lane: string | undefined, spec: string | undefined, body: string }}
 */
export function parseDispatchAnswer(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const headText = split >= 0 ? normalized.slice(0, split) : normalized;
  const body = split >= 0 ? normalized.slice(split + 2).trim() : '';
  /** @type {Record<string, string>} */
  const header = {};
  for (const line of headText.split('\n')) {
    const m = /^([a-z][a-z-]*): (.*)$/.exec(line);
    if (m) header[m[1]] = m[2];
  }
  const laneLine = header.lane ?? '';
  const laneMatch = /^(\S+)(?: \((.+)\))?$/.exec(laneLine);
  return {
    header,
    lane: laneMatch ? laneMatch[1] : undefined,
    spec: laneMatch?.[2],
    body,
  };
}

/**
 * One `llm-relay mcp` child with its handshake in flight.
 *
 * @param {{ command: string, args: string[], cwd: string, spawnImpl: typeof spawn,
 *   protocolVersion: string, onStderr: (chunk: string) => void }} opts
 */
function startChild({ command, args, cwd, spawnImpl, protocolVersion, onStderr }) {
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
        continue; // Not protocol — a stray write the server itself warns against.
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
  child.on('error', (err) => settle(`dispatch server failed to start: ${err.message}`));
  child.on('exit', (code, signal) => settle(`dispatch server exited (${signal ?? code}) before answering`));

  const write = (/** @type {object} */ message) => {
    try {
      child.stdin.write(JSON.stringify(message) + '\n');
    } catch (err) {
      settle(`dispatch server stdin closed: ${/** @type {any} */ (err)?.message ?? err}`);
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
          child.stdin.end(); // The server treats stdin end as its ordinary end of life.
        } catch {}
      }),
  };
}

/**
 * Open a dispatch lane: a pool of `size` `llm-relay mcp` children.
 *
 * @param {object} [opts]
 * @param {number} [opts.size] concurrent dispatches — one child each (default 1)
 * @param {string} [opts.command] the server executable (default the global `llm-relay` shim)
 * @param {string[]} [opts.args] its arguments (default `['mcp']`)
 * @param {string} [opts.cwd] working directory for the children AND the default
 *   `cwd` a dispatch names for an agent-mode lane
 * @param {typeof spawn} [opts.spawnImpl] test seam
 * @param {string} [opts.protocolVersion]
 * @param {(chunk: string) => void} [opts.onStderr] the children's stderr (default: forwarded)
 */
export function openDispatchLane({
  size = 1,
  command = platformCommand('llm-relay'),
  args = ['mcp'],
  cwd = process.cwd(),
  spawnImpl = spawn,
  protocolVersion = MCP_PROTOCOL_VERSION,
  onStderr = (chunk) => process.stderr.write(chunk),
} = {}) {
  const slots = Array.from({ length: Math.max(1, size) }, () =>
    startChild({ command, args, cwd, spawnImpl, protocolVersion, onStderr }),
  );
  const idle = [...slots];
  /** @type {Array<(slot: ReturnType<typeof startChild>) => void>} */
  const waiters = [];

  const acquire = () =>
    new Promise((resolve, reject) => {
      const live = idle.findIndex((s) => !s.isDead());
      if (live >= 0) {
        resolve(idle.splice(live, 1)[0]);
        return;
      }
      idle.length = 0; // Only dead slots were left; drop them.
      if (slots.every((s) => s.isDead())) {
        reject(new DispatchLaneError('every dispatch server process has exited'));
        return;
      }
      waiters.push(resolve);
    });
  const release = (/** @type {ReturnType<typeof startChild>} */ slot) => {
    const waiter = waiters.shift();
    if (waiter) waiter(slot);
    else idle.push(slot);
  };

  return {
    /**
     * Dispatch ONE task and return its terminal answer.
     *
     * @param {string} task
     * @param {object} [opts]
     * @param {'answer' | 'agent'} [opts.mode] default `answer`: a relay lane is
     *   POSTed directly, no harness; a CLI rung runs as an agent either way
     * @param {string} [opts.system] answer mode only
     * @param {Record<string, unknown>} [opts.schema] answer mode only: forces
     *   the answer into one tool call whose input is returned JSON-stringified
     * @param {number} [opts.maxTokens] answer mode only
     * @param {number} [opts.timeoutMs] ceiling on the lane run
     * @param {string} [opts.cwd] agent mode: where the lane runs (default the lane's `cwd`)
     * @returns {Promise<{ raw: string, status: string, lane: string, spec: string | undefined,
     *   servedBy: string | undefined, error: string | undefined, header: Record<string, string> }>}
     */
    async dispatch(task, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
      const slot = await acquire();
      try {
        await slot.ready;
        const reply = await slot.request('tools/call', {
          name: 'dispatch',
          arguments: {
            task,
            mode: opts.mode ?? 'answer',
            ...(opts.system !== undefined ? { system: opts.system } : {}),
            ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
            ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
            cwd: opts.cwd ?? cwd,
            timeoutMs,
            waitMs: timeoutMs + WAIT_GRACE_MS,
          },
        });
        if (reply.error) {
          throw new DispatchLaneError(`dispatch refused: ${reply.error.message}`);
        }
        const content = Array.isArray(reply.result?.content) ? reply.result.content : [];
        const text = content
          .filter((/** @type {any} */ c) => c && c.type === 'text' && typeof c.text === 'string')
          .map((/** @type {any} */ c) => c.text)
          .join('');
        const { header, lane, spec, body } = parseDispatchAnswer(text);
        const status = header.status ?? (reply.result?.isError ? 'failed' : 'completed');
        if (status === 'running') {
          // Cannot happen with waitMs past timeoutMs; if the server changes
          // that contract this is a transport fault, not a lane verdict.
          throw new DispatchLaneError(`dispatch returned a running job: ${header.job ?? '?'}`, { header, body });
        }
        return {
          raw: body,
          status,
          lane: lane ?? 'unknown',
          spec,
          servedBy: header['served-by'],
          error: header.error,
          header,
        };
      } finally {
        release(slot);
      }
    },

    /** End every child; the pool is unusable afterwards. */
    async close() {
      await Promise.all(slots.map((s) => s.close()));
    },
  };
}
