// Declared offload-lane registry — every delegation lane a session in this
// checkout plans around, held as DATA and reconciled by
// `scripts/check-offload-lanes.mjs` (`npm run check:offload-lanes`), the same
// shape as scripts/guard-reach-data.mjs (P36 / solN-1: the retired guard leg
// hardcoded ONE lane URL whose probe could not fail — the router's SPA
// catch-all answers 200 on ANY path — so the Codex lane was dead for a whole
// run, 2026-08-18, and nothing said so).
//
// Consumers: `.claude/hooks/session-start-guards.mjs` (the lane-liveness leg
// probes every probeable row concurrently at session start, so a dead lane is
// a named constraint at lap start rather than a mid-lap stall) and the
// reconciliation gate above.
//
// SEMANTICS — read before editing:
//   • A probe proves REACHABLE TRANSPORT only, never that a model will serve,
//     that quota remains, or that a dispatched session will finish. 401 in
//     `upStatuses` is deliberate: "up, key wrong" is a different failure with
//     a different remedy, and conflating the two makes the probe untrustworthy.
//   • `requireJsonOn` lists statuses that count as up only with a JSON
//     content-type — the catch-all serves 200 text/html for any unmatched
//     path, so a bare-status 200 can never distinguish "API surface alive"
//     from "a web server is listening".
//   • `probe: null` is the honest unprobeable answer; `unprobeableReason` is
//     REQUIRED there (reconciled). Unprobeable lanes are SILENT at session
//     start — an every-session line would be read past.
//   • `configDirTrust` is a SECOND, independent question (P43 / sol-4): a
//     Claude lane launched with an isolated CLAUDE_CONFIG_DIR that has not
//     trusted this workspace does not error — it runs with no repo tools and
//     answers from nothing, in the right shape, with fabricated supporting
//     quotes (2026-08-07/13/14/15). Trust is per-project and NOT inherited
//     from a parent path, and the state is readable BEFORE dispatch, so this
//     check spends no quota. `configDirTrust: null` is the uncheckable answer
//     and REQUIRES `trustUncheckableReason` — lanes that receive inlined
//     content or run a non-Claude client have no such trust file and must
//     never red for lacking one. The repairing half lives in the launcher
//     OUTSIDE this repo (`claude.ps1` refuses on the same condition), so the
//     session-start leg REPORTS and never repairs; trust can also change
//     between session start and dispatch, so a stale green is possible.
//   • The lane AUTHORITY is ~/.claude/CLAUDE.md — untracked and per-machine. A
//     gate must not ask the local disk, so the reconciler checks these rows
//     only against the TRACKED docs in SCANNED_DOCS; the global lane list
//     stays an uncovered half, stated on the check:offload-lanes guard row.

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
 * @typedef {object} ConfigDirTrust
 * @property {string} configDir absolute path of the isolated CLAUDE_CONFIG_DIR
 *   the lane launches with; its `.claude.json` `projects` map is the trust
 *   record
 * @property {string} envOverride env var replacing configDir for tests, or the
 *   literal 'skip' to leave the lane's trust unchecked
 * @property {string} untrustedRemedy the one line a session can act on when the
 *   workspace is untrusted — printed verbatim in the session-start note
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
 * @property {ConfigDirTrust|null} configDirTrust workspace-trust precondition,
 *   or null when the lane has no such config dir
 * @property {string} [trustUncheckableReason] REQUIRED when configDirTrust is
 *   null
 * @property {string} remedy the one line a session can act on when the lane is
 *   down — printed verbatim in the session-start note
 * @property {string} [note]
 */

/** @type {LaneRow[]} */
export const OFFLOAD_LANES = [
  {
    id: 'freellmapi-router',
    kind: 'router',
    label: 'FreeLLMAPI router (free pool)',
    transport: 'http://127.0.0.1:3001',
    probe: {
      kind: 'http',
      url: 'http://127.0.0.1:3001/v1/models',
      timeoutMs: 2_000,
      upStatuses: [200, 401],
      requireJsonOn: [200],
    },
    envOverride: 'AUDIT_TOOLS_OFFLOAD_PROBE_URL',
    configDirTrust: null,
    trustUncheckableReason:
      'transport, not a reading client — the router opens no workspace and has no config dir of its ' +
      'own; every lane riding it answers this question on its own row',
    remedy: 'powershell -File C:\\Users\\ethan\\freellmapi\\start.ps1',
    note:
      '/v1/models is a REAL route (verified 2026-08-18: 401 application/json with no key; ' +
      '/health and any other unmatched path get 200 text/html from the SPA catch-all, which is ' +
      'why the retired bare-status probe could never fail). Every MCP offload lane below rides ' +
      'this transport.',
  },
  {
    id: 'mcp-pool',
    kind: 'mcp-offload',
    label: 'freellmapi MCP offload lane: pool',
    transport: 'freellmapi MCP server, in the :3001 router process',
    probe: null,
    unprobeableReason:
      "transport liveness is the freellmapi-router row's probe; whether the lane will SERVE " +
      '(models, quota, a finishing session) is unknowable without spending a real call',
    configDirTrust: {
      configDir: 'C:\\Users\\ethan\\freellmapi\\claude-config',
      envOverride: 'AUDIT_TOOLS_POOL_TRUST_DIR',
      untrustedRemedy:
        "add this workspace to that dir's .claude.json as " +
        "projects['<workspace>'].hasTrustDialogAccepted = true, then re-dispatch — the freellmapi " +
        'launcher owns that file and refuses on the same condition, so this leg reports and cannot repair',
    },
    remedy:
      'powershell -File C:\\Users\\ethan\\freellmapi\\start.ps1 — then verify with the ' +
      'mcp__freellmapi__offload_lanes tool',
    note:
      'Observed 2026-08-18: this lane spawns `claude.exe -p` with the repo as cwd WITHOUT ' +
      'AUDIT_TOOLS_CHILD_SESSION=1 — the env is freellmapi-server-side (the claude.ps1 launcher ' +
      'was fixed the same day; this lane was not), so the child self-registered as an OWNER ' +
      'session and its Stop closeout-challenge REPLACED the final answer. FIXED 2026-08-19: the ' +
      "pool lane's env in the server's offload-lanes.json now sets AUDIT_TOOLS_CHILD_SESSION=1 — " +
      'config-only, mtime-memoized reload, no restart.',
  },
  {
    id: 'mcp-agy-recon',
    kind: 'mcp-offload',
    label: 'freellmapi MCP offload lane: agy-recon',
    transport: 'freellmapi MCP server → client-bound agy credential',
    probe: null,
    unprobeableReason:
      'composite lane: MCP transport is covered by the freellmapi-router probe and the agy binary ' +
      'by the agy-cli probe; whether a dispatch will serve is unknowable without spending quota',
    configDirTrust: null,
    trustUncheckableReason:
      'agy is not a Claude client — no CLAUDE_CONFIG_DIR workspace-trust record exists to read; its ' +
      'workspace comes from the lane --add-dir argument',
    remedy:
      'powershell -File C:\\Users\\ethan\\freellmapi\\start.ps1 for the MCP side; see the agy-cli ' +
      'row for the credential side',
  },
  {
    id: 'mcp-agy-opus',
    kind: 'mcp-offload',
    label: 'freellmapi MCP offload lane: agy-opus',
    transport: 'freellmapi MCP server → client-bound agy credential',
    probe: null,
    unprobeableReason:
      'same composite as mcp-agy-recon (router MCP + agy credential) — covered by those two ' +
      "rows' probes; lane-serves is unknowable without spending quota",
    configDirTrust: null,
    trustUncheckableReason:
      'same as mcp-agy-recon — agy carries no CLAUDE_CONFIG_DIR trust record',
    remedy:
      'powershell -File C:\\Users\\ethan\\freellmapi\\start.ps1 for the MCP side; see the agy-cli ' +
      'row for the credential side',
  },
  {
    id: 'mcp-codex-recon',
    kind: 'mcp-offload',
    label: 'freellmapi MCP offload lane: codex-recon',
    transport: 'freellmapi MCP server → codex CLI → headroom :8787',
    probe: null,
    unprobeableReason:
      'composite lane: MCP transport is covered by the freellmapi-router probe and the headroom ' +
      'transport by the codex-cli probe; lane-serves is unknowable without spending quota',
    configDirTrust: null,
    trustUncheckableReason:
      'codex is not a Claude client — no CLAUDE_CONFIG_DIR trust record exists; the lane receives ' +
      'inlined prompt content',
    remedy:
      'powershell -File C:\\Users\\ethan\\freellmapi\\start.ps1 for the MCP side; see the ' +
      'codex-cli row for the headroom side',
  },
  {
    id: 'mcp-codex-write',
    kind: 'mcp-offload',
    label: 'freellmapi MCP offload lane: codex-write',
    transport: 'freellmapi MCP server → codex CLI → headroom :8787',
    probe: null,
    unprobeableReason:
      'same composite as mcp-codex-recon (router MCP + codex/headroom) — covered by those two ' +
      "rows' probes; lane-serves is unknowable without spending quota",
    configDirTrust: null,
    trustUncheckableReason:
      'same as mcp-codex-recon — codex carries no CLAUDE_CONFIG_DIR trust record',
    remedy:
      'powershell -File C:\\Users\\ethan\\freellmapi\\start.ps1 for the MCP side; see the ' +
      'codex-cli row for the headroom side',
  },
  {
    id: 'agy-cli',
    kind: 'peer-cli',
    label: 'Antigravity peer CLI (`agy -p`)',
    transport: 'client-bound agy.exe — no proxy on the path',
    probe: { kind: 'command', command: 'agy', args: ['--version'], timeoutMs: 3_000 },
    envOverride: 'AUDIT_TOOLS_AGY_PROBE_CMD',
    configDirTrust: null,
    trustUncheckableReason:
      'agy is not a Claude client — no CLAUDE_CONFIG_DIR trust record; a prompt carries inlined ' +
      'content and an explicit workspace argument',
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
    label: 'Codex peer CLI (`codex exec`) via headroom',
    transport: 'http://127.0.0.1:8787 (headroom)',
    probe: {
      kind: 'http',
      url: 'http://127.0.0.1:8787/stats',
      timeoutMs: 2_000,
      upStatuses: [200],
    },
    envOverride: 'AUDIT_TOOLS_HEADROOM_PROBE_URL',
    configDirTrust: null,
    trustUncheckableReason:
      'codex is not a Claude client — no CLAUDE_CONFIG_DIR trust record to read',
    remedy:
      'wscript.exe "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\headroom.vbs" ' +
      '(`cmd /c start` on a .vbs opens a shell instead of launching it)',
    note:
      'the lane that was dead all run 2026-08-18 (os error 10061 on :8787) while the retired ' +
      'guard probed only :3001. /stats is the documented live route (probed 200 application/json, ' +
      '2026-08-18).',
  },
  {
    id: 'claude-ps1-launcher',
    kind: 'launcher',
    label: 'pool launcher claude.ps1',
    transport: 'powershell -File C:\\Users\\ethan\\freellmapi\\claude.ps1 → nested claude.exe → the :3001 router',
    probe: null,
    unprobeableReason:
      'a launcher script, not a service — nothing listens. Its lane health is the ' +
      'freellmapi-router probe plus nested claude.exe session startup, which is minutes-slow by ' +
      'design and cannot be probed cheaply',
    configDirTrust: {
      configDir: 'C:\\Users\\ethan\\freellmapi\\claude-config',
      envOverride: 'AUDIT_TOOLS_LAUNCHER_TRUST_DIR',
      untrustedRemedy:
        "add this workspace to that dir's .claude.json as " +
        "projects['<workspace>'].hasTrustDialogAccepted = true, then re-dispatch — the freellmapi " +
        'launcher owns that file and refuses on the same condition, so this leg reports and cannot repair',
    },
    remedy:
      'powershell -File C:\\Users\\ethan\\freellmapi\\start.ps1 (the launcher starts the router ' +
      'itself when down; a hung launcher is usually nested session startup, not the pool)',
    note:
      'fixed 2026-08-18 to set AUDIT_TOOLS_CHILD_SESSION=1 on the child; the MCP pool lane above ' +
      'remains unfixed and is the open half of that trap.',
  },
];

// Doc→row coverage: lane spellings the TRACKED docs use, tied to the row each
// names. Deleting a lane row while its marker entry (or the doc text) survives
// is a red build — a documented lane cannot be silently unprobed; a marker that
// no scanned doc contains any more is registry rot and equally red.
/** @type {{ marker: string, laneId: string }[]} */
export const DOC_LANE_MARKERS = [
  { marker: '127.0.0.1:3001', laneId: 'freellmapi-router' },
  { marker: 'codex exec', laneId: 'codex-cli' },
  { marker: 'agy -p', laneId: 'agy-cli' },
  { marker: 'claude.ps1', laneId: 'claude-ps1-launcher' },
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

/**
 * One workspace path in the comparable form: forward slashes, no trailing
 * separator, case-folded (git and the launcher disagree on drive-letter case).
 *
 * @param {string} workspacePath
 */
function normalizeWorkspaceKey(workspacePath) {
  return String(workspacePath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Classify one config dir's `.claude.json` against a workspace. Pure —
 * unit-testable without a config dir.
 *
 * Trust is per-project and NOT inherited: a trusted PARENT path leaves the
 * workspace untrusted, which is exactly how `C:/Code` being listed hid the
 * 2026-08-15 fabrication.
 *
 * @param {string} trustFileText raw `.claude.json`
 * @param {string} workspacePath
 * @returns {boolean|null} true = trusted, false = untrusted, null = unknown
 *   (unparseable, or no `projects` map — never a guess)
 */
export function classifyConfigDirTrust(trustFileText, workspacePath) {
  let parsed;
  try {
    parsed = JSON.parse(trustFileText);
  } catch {
    return null;
  }
  const projects = parsed?.projects;
  if (projects === null || typeof projects !== 'object') return null;
  const wanted = normalizeWorkspaceKey(workspacePath);
  for (const [key, entry] of Object.entries(projects)) {
    if (normalizeWorkspaceKey(key) !== wanted) continue;
    return entry?.hasTrustDialogAccepted === true;
  }
  return false;
}

/**
 * Read one lane's workspace-trust state. Never throws, spends no quota.
 *
 * A config dir that cannot be read at all answers null, not false: the whole
 * launcher install may be absent on this machine, and an absent install must
 * not red a lane every session. The discriminator is a config dir that EXISTS
 * and does not list this workspace.
 *
 * @param {LaneRow} lane
 * @param {string} workspacePath
 * @param {Record<string, string|undefined>} [env]
 * @returns {Promise<boolean|null>} true = trusted, false = UNUSABLE, null =
 *   unchecked/unknown
 */
export async function checkLaneTrust(lane, workspacePath, env = process.env) {
  const trust = lane.configDirTrust;
  if (!trust) return null;
  const override = env[trust.envOverride];
  if (override === 'skip') return null;
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let text;
  try {
    text = await readFile(join(override || trust.configDir, '.claude.json'), 'utf8');
  } catch {
    return null;
  }
  return classifyConfigDirTrust(text, workspacePath);
}

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
  return new Promise((resolve) => {
    const done = onceResolver(resolve);
    try {
      // stdio all-ignore closes the child's stdin, so a prompt-happy CLI cannot
      // hang the hook (the codex/agy stdin traps); the timer is the hard bound.
      const child = spawn(commandOverride || probe.command, probe.args, {
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
