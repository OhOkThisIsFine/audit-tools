// Declared offload-lane registry — every delegation lane a session on THIS
// MACHINE plans around, held as DATA beside its authority (~/.claude/CLAUDE.md,
// the per-machine lane topology). Moved here from audit-tools
// scripts/shared/offload-lane-data.mjs on 2026-08-29 (owner decision, ceremony
// review F10): lane inventory is machine-scoped, not repo-scoped, and the
// in-repo reconciliation gate could not see this file's true authority anyway.
// The eventual owner is llm-relay (lane inventory + a query surface); this
// file is the interim.
//
// RETIREMENT 2026-08-29 (owner decision): freellmapi (:3001) is retired —
// its router row, the five MCP job lanes, and the claude.ps1 launcher row
// were removed; the llm-relay rows (:8791) replace them. Evidence and the
// cutover record: C:\Code\llm-relay\docs\freellmapi-takeover-readiness-2026-08-29.md.
// ⚠ claude.ps1 STARTS the retired router if run — do not dispatch through it.
//
// P36 / solN-1 history (why declared data): the retired guard leg hardcoded
// ONE lane URL whose probe could not fail — a router SPA catch-all answered
// 200 on ANY path — so the Codex lane was dead for a whole run, 2026-08-18,
// and nothing said so.
//
// Consumers: audit-tools' `.claude/hooks/session-start-guards.mjs` (the
// lane-liveness leg dynamically imports this file by homedir path, probes every
// probeable row concurrently at session start, and SKIPS silently when this
// file is absent — a machine without a lane registry has no declared lanes).
// There is no reconciliation gate any more: edit with care, this file is the
// only copy.
//
// SEMANTICS — read before editing:
//   • A probe proves REACHABLE TRANSPORT only, never that a model will serve,
//     that quota remains, or that a dispatched session will finish. 401 in
//     `upStatuses` is deliberate: "up, key wrong" is a different failure with
//     a different remedy, and conflating the two makes the probe untrustworthy.
//   • `requireJsonOn` lists statuses that count as up only with a JSON
//     content-type — an SPA catch-all can serve 200 text/html for any
//     unmatched path, so a bare-status 200 can never distinguish "API surface
//     alive" from "a web server is listening".
//   • `probe: null` is the honest unprobeable answer; `unprobeableReason` is
//     REQUIRED there (reconciled). Unprobeable lanes are SILENT at session
//     start — an every-session line would be read past.
//   • There is NO workspace-trust leg. One was removed 2026-08-29 because
//     measurement refuted its premise — see the block above `probeLane`.
//   • The lane AUTHORITY is ~/.claude/CLAUDE.md — untracked and per-machine. A
//     gate must not ask the local disk, so any reconciler checks these rows
//     only against the TRACKED docs in SCANNED_DOCS; the global lane list
//     stays an uncovered half.

/**
 * @typedef {object} HttpProbe
 * @property {'http'} kind
 * @property {string} url probed with a single GET, bounded by timeoutMs
 * @property {number} timeoutMs
 * @property {number[]} upStatuses statuses that classify the lane up
 * @property {number[]} [requireJsonOn] statuses (⊆ upStatuses) that are up ONLY
 *   with a JSON content-type — the SPA-catch-all discriminator
 */

/**
 * @typedef {object} CommandProbe
 * @property {'command'} kind
 * @property {string} command spawned directly (no shell), stdio ignored,
 *   windowsHide, killed at timeoutMs — exit 0 within the bound = up
 * @property {string[]} args
 * @property {number} timeoutMs
 */

/**
 * @typedef {object} LaneRow
 * @property {string} id
 * @property {'router'|'mcp-offload'|'peer-cli'|'launcher'} kind
 * @property {string} label
 * @property {string} transport where dispatches actually travel — the thing the
 *   probe reaches (or the reason nothing can)
 * @property {HttpProbe|CommandProbe|null} probe
 * @property {string} [envOverride] env var that redirects the probe for tests:
 *   an http probe reads it as a replacement URL; a command probe reads it as a
 *   replacement command, or the literal 'skip' to leave the lane unprobed
 * @property {string} [unprobeableReason] REQUIRED when probe is null
 * @property {string} remedy the one line a session can act on when the lane is
 *   down — printed verbatim in the session-start note
 * @property {string} [note]
 */

/** @type {LaneRow[]} */
export const OFFLOAD_LANES = [
  {
    id: 'llm-relay-router',
    kind: 'router',
    label: 'llm-relay (free pools + dispatch)',
    transport: 'http://127.0.0.1:8791',
    probe: {
      kind: 'http',
      url: 'http://127.0.0.1:8791/telemetry',
      timeoutMs: 2_000,
      upStatuses: [200],
      requireJsonOn: [200],
    },
    envOverride: 'AUDIT_TOOLS_OFFLOAD_PROBE_URL',
    remedy:
      'wscript.exe "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\llm-relay.vbs" ' +
      '(`cmd /c start` on a .vbs opens a shell instead of launching it)',
    note:
      '/telemetry is the tokenless liveness route (200 application/json). ⚠ /health and /ping ' +
      'answer 403 BY DESIGN — they are control routes; a probe there reads a healthy relay as ' +
      'down. Replaced the freellmapi-router row on retirement (2026-08-29).',
  },
  {
    id: 'relay-pool-lane',
    kind: 'launcher',
    label: 'llm-relay free-pool lane (dispatch: free-pool)',
    transport:
      'llm-relay dispatch → claude.exe (CLAUDE_CONFIG_DIR C:\\Users\\ethan\\.llm-relay-claude) → http://127.0.0.1:8791',
    probe: null,
    unprobeableReason:
      "dispatch-time lane, not a service — nothing listens. Transport liveness is the " +
      "llm-relay-router row's probe; whether a session will SERVE (models, quota, a finishing " +
      'session) is unknowable without spending a real call',
    remedy:
      'start the relay (see llm-relay-router), then `llm-relay dispatch -t "<task>"` — the ladder ' +
      'leads with free-pool and prints the exact command to run',
    note:
      'replaced the freellmapi mcp-pool and claude.ps1 launcher rows on retirement (2026-08-29). ' +
      'The relay hands the host the lane command; the host runs it — there is no server-side job ' +
      'runner any more.',
  },
  {
    id: 'agy-cli',
    kind: 'peer-cli',
    label: 'Antigravity peer CLI (`agy -p`)',
    transport: 'client-bound agy.exe — no proxy on the path',
    probe: { kind: 'command', command: 'agy', args: ['--version'], timeoutMs: 3_000 },
    envOverride: 'AUDIT_TOOLS_AGY_PROBE_CMD',
    remedy:
      'reinstall/update the Antigravity CLI (`agy`) — client-bound, there is no local service to ' +
      'restart',
    note:
      'the probe proves the binary is installed and launchable (sub-second, spends no quota — ' +
      'verified 2026-08-18, `agy --version` → 1.1.14) — NOT that a session will serve or that ' +
      'quota remains. Every agy prompt must say "do not run shell commands": agy has no shell, ' +
      'and a denied tool discards the entire answer.',
  },
  {
    id: 'codex-cli',
    kind: 'peer-cli',
    label: 'Codex peer CLI (`codex exec`) direct to OpenAI',
    transport: 'OpenAI Responses API',
    probe: {
      kind: 'command',
      command: 'codex',
      args: ['--version'],
      timeoutMs: 10_000,
    },
    remedy: 'repair or reinstall the Codex CLI and verify `codex --version`',
    note: 'the probe proves the CLI is installed and launchable; it does not spend quota.',
  },
];

// Doc→row coverage: lane spellings the TRACKED docs use, tied to the row each
// names. Deleting a lane row while its marker entry (or the doc text) survives
// is a red build — a documented lane cannot be silently unprobed; a marker that
// no scanned doc contains any more is registry rot and equally red.
// (The freellmapi markers — '127.0.0.1:3001', 'claude.ps1' — were removed with
// their rows on retirement 2026-08-29.)
/** @type {{ marker: string, laneId: string }[]} */
export const DOC_LANE_MARKERS = [
  { marker: 'codex exec', laneId: 'codex-cli' },
  { marker: 'agy -p', laneId: 'agy-cli' },
];

// The tracked docs the reconciler scans for DOC_LANE_MARKERS — deliberately NOT
// ~/.claude/CLAUDE.md (untracked; a gate must not ask the local disk).
export const SCANNED_DOCS = ['docs/nightly-routine.md', 'docs/backlog/durable-traps.md'];

/**
 * Classify one observed http response for a lane probe. Pure — unit-testable
 * without a socket.
 *
 * @param {HttpProbe} probe
 * @param {{ statusCode: number|undefined, contentType: string|undefined }} response
 * @returns {boolean} up
 */
export function classifyHttpProbe(probe, { statusCode, contentType }) {
  if (typeof statusCode !== 'number' || !probe.upStatuses.includes(statusCode)) return false;
  if ((probe.requireJsonOn ?? []).includes(statusCode)) return /\bjson\b/i.test(contentType ?? '');
  return true;
}

/**
 * Probe one lane. Bounded (the probe's own timeoutMs), never throws.
 *
 * @param {LaneRow} lane
 * @param {Record<string, string|undefined>} [env]
 * @returns {Promise<boolean|null>} true = up, false = down, null = unprobed
 *   (no probe declared, or a command probe overridden to 'skip')
 */
export async function probeLane(lane, env = process.env) {
  const override = lane.envOverride ? env[lane.envOverride] : undefined;
  if (lane.probe === null) return null;
  if (lane.probe.kind === 'http') return probeHttp(lane.probe, override);
  if (override === 'skip') return null;
  return probeCommand(lane.probe, override);
}

// ── Workspace trust: REMOVED 2026-08-29, premise refuted by measurement ──────
//
// This registry used to carry `configDirTrust`, `classifyConfigDirTrust` and
// `checkLaneTrust`. The session-start leg that consumed them reported an
// untrusted workspace as "OFFLOAD LANE UNUSABLE … it runs with no repo tools and
// answers from nothing" (P43 / sol-4).
//
// The consequence does not follow from the condition. Measured against the live
// llm-relay pool lane, four ways, 2026-08-29:
//   1. a read-only lane (--allowedTools Read,Glob,Grep) launched in a worktree
//      ABSENT from the config dir's `projects` map read a GITIGNORED file and
//      returned its unguessable 40-hex content;
//   2. the same lane, from a directory under no repository and named in no
//      projects map, returned a 40-hex token written there moments earlier;
//   3. the same worktree with NO --allowedTools flag at all returned the same
//      correct 40-hex value;
//   4. a lane with write tools in that worktree ran `git push` for real.
//
// The isolated config dir also has NO settings.json and no `permissions` block,
// so the "Ignoring N permissions.allow entries" symptom recorded on 2026-08-15
// belongs to an EARLIER config dir, not to this lane.
//
// A precondition whose stated consequence never follows is a false red, and this
// one cost a full lap planned around a lane that worked. It is DELETED rather
// than softened: a leg with no predictive value is not made honest by hedging its
// wording, and a hedged leg still prints every session.
// Restore from `offload-lane-data.mjs.bak-2026-08-29-pre-trust-leg-removal` only
// together with a measurement showing trust gating tools again.

/** Wrap a promise resolver so only the first settlement wins. */
function onceResolver(resolve) {
  let settled = false;
  return (v) => {
    if (settled) return;
    settled = true;
    resolve(v);
  };
}

/** @param {HttpProbe} probe @param {string|undefined} urlOverride */
async function probeHttp(probe, urlOverride) {
  const { get } = await import('node:http');
  return new Promise((resolve) => {
    const done = onceResolver(resolve);
    try {
      const req = get(urlOverride || probe.url, (res) => {
        res.resume(); // drain — status + content-type are the whole signal
        done(classifyHttpProbe(probe, { statusCode: res.statusCode, contentType: res.headers['content-type'] }));
      });
      req.setTimeout(probe.timeoutMs, () => {
        req.destroy();
        done(false);
      });
      req.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}

/** @param {CommandProbe} probe @param {string|undefined} commandOverride */
async function probeCommand(probe, commandOverride) {
  const { spawn } = await import('node:child_process');
  const { buildSpawnArgs } = await import('./capture-run.mjs');
  return new Promise((resolve) => {
    const done = onceResolver(resolve);
    try {
      // stdio all-ignore closes the child's stdin, so a prompt-happy CLI cannot
      // hang the hook (the codex/agy stdin traps); the timer is the hard bound.
      // argv[0] is resolved through the machine's ONE shim resolver
      // (`buildSpawnArgs`, capture-run.mjs). A bare `spawn` cannot execute a
      // Windows npm shim, so `codex` — installed only as `codex.cmd` — raised
      // ENOENT and this probe reported the lane DOWN while the CLI answered in
      // ~260 ms. A launch defect must never be readable as a dead lane.
      const built = buildSpawnArgs([commandOverride || probe.command, ...probe.args]);
      const child = spawn(built.file, built.args, {
        ...built.options,
        stdio: 'ignore',
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        done(false);
      }, probe.timeoutMs);
      timer.unref?.();
      child.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(false);
    }
  });
}
