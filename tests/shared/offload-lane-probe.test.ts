// Contract tests for the offload-lane registry + probe substrate
// (`scripts/shared/offload-lane-data.mjs`), its reconciliation gate
// (`scripts/check-offload-lanes.mjs`), and the session-start-guards
// lane-liveness leg end-to-end (P36 / solN-1).
//
// The defect class this pins closed: the retired guard leg hardcoded ONE lane
// URL (`/health` on the router) whose probe could not fail — the SPA catch-all
// answers 200 text/html on ANY path — so a dead Codex lane (headroom :8787)
// was invisible for a whole run. The registry declares every lane; the probe
// classifies a catch-all 200 as DOWN; the reconciler pins the vacuous probe
// out of the hook forever.
//
// Same placement rule as the other hook tests: under tests/ because vitest
// excludes `.claude/**`, so a test beside a hook never runs in CI.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnHidden } from '../helpers/spawn.mjs';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  OFFLOAD_LANES as lanesImpl,
  DOC_LANE_MARKERS as markersImpl,
  SCANNED_DOCS as scannedDocsImpl,
  classifyHttpProbe as classifyImpl,
  probeLane as probeLaneImpl,
  classifyConfigDirTrust as classifyTrustImpl,
  checkLaneTrust as checkLaneTrustImpl,
} from '../../scripts/shared/offload-lane-data.mjs';
import { reconcile as reconcileImpl } from '../../scripts/check-offload-lanes.mjs';

// ── local mirrors of the JSDoc typedefs in offload-lane-data.mjs ─────────────
interface HttpProbe {
  kind: 'http';
  url: string;
  timeoutMs: number;
  upStatuses: number[];
  requireJsonOn?: number[];
}
interface CommandProbe {
  kind: 'command';
  command: string;
  args: string[];
  timeoutMs: number;
}
interface ConfigDirTrust {
  configDir: string;
  envOverride: string;
  untrustedRemedy: string;
}
interface LaneRow {
  id: string;
  kind: 'router' | 'mcp-offload' | 'peer-cli' | 'launcher';
  label: string;
  transport: string;
  probe: HttpProbe | CommandProbe | null;
  envOverride?: string;
  unprobeableReason?: string;
  configDirTrust: ConfigDirTrust | null;
  trustUncheckableReason?: string;
  remedy: string;
  note?: string;
}
interface MarkerRow {
  marker: string;
  laneId: string;
}
type ReconcileArgs = {
  lanes: LaneRow[];
  markers: MarkerRow[];
  hookSource: string;
  docTexts: Record<string, string>;
};

const LANES = lanesImpl as LaneRow[];
const MARKERS = markersImpl as MarkerRow[];
const SCANNED_DOCS = scannedDocsImpl as string[];
const classifyHttpProbe = classifyImpl as (
  probe: HttpProbe,
  response: { statusCode: number | undefined; contentType: string | undefined },
) => boolean;
const probeLane = probeLaneImpl as (
  lane: LaneRow,
  env?: Record<string, string | undefined>,
) => Promise<boolean | null>;
const reconcile = reconcileImpl as (args: ReconcileArgs) => string[];
const classifyConfigDirTrust = classifyTrustImpl as (
  trustFileText: string,
  workspacePath: string,
) => boolean | null;
const checkLaneTrust = checkLaneTrustImpl as (
  lane: LaneRow,
  workspacePath: string,
  env?: Record<string, string | undefined>,
) => Promise<boolean | null>;

/** A scratch CLAUDE_CONFIG_DIR holding one .claude.json with the given projects map. */
function trustDir(projects: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lanetrust-'));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ projects }), 'utf8');
  return dir;
}

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const GUARDS = join(REPO_ROOT, '.claude', 'hooks', 'session-start-guards.mjs');

function laneById(id: string): LaneRow {
  const lane = LANES.find((l) => l.id === id);
  if (!lane) throw new Error(`registry has no lane "${id}"`);
  return lane;
}

// An unroutable loopback port: connections are refused instantly, no timeout burned.
const CLOSED = 'http://127.0.0.1:9/';

// ── fake servers ─────────────────────────────────────────────────────────────
const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
});

/** A local server; returns its base URL once listening. */
function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no address');
      done(`http://127.0.0.1:${addr.port}`);
    });
  });
}

/** The SPA catch-all clone: 200 text/html on EVERY path — the vacuous-probe shape. */
const catchAll = () =>
  serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html>spa</html>');
  });

/** A real-router clone: /v1/models is a live (auth-gated) route, all else catch-all. */
const realRouter = () =>
  serve((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"error":"missing key"}');
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html>spa</html>');
    }
  });

// ── the registry declares the lanes P36 found missing ────────────────────────

describe('offload-lane registry shape', () => {
  it('declares the headroom transport (the lane that was dead all run 2026-08-18)', () => {
    // RED (b) at HEAD-before: no registry existed at all.
    const headroom = LANES.filter(
      (l) => l.transport.includes('127.0.0.1:8787') || (l.probe?.kind === 'http' && l.probe.url.includes('127.0.0.1:8787')),
    );
    expect(headroom.length).toBeGreaterThan(0);
  });

  it('declares every session-verified lane: router, the five MCP offload lanes, both peer CLIs, the launcher', () => {
    const ids = LANES.map((l) => l.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'freellmapi-router',
        'mcp-pool',
        'mcp-agy-recon',
        'mcp-agy-opus',
        'mcp-codex-recon',
        'mcp-codex-write',
        'agy-cli',
        'codex-cli',
        'claude-ps1-launcher',
      ]),
    );
  });

  it('probes the router on the real /v1/models route — the vacuous /health probe appears nowhere', () => {
    const router = laneById('freellmapi-router');
    expect(router.probe?.kind).toBe('http');
    expect((router.probe as HttpProbe).url).toContain('/v1/models');
    // No lane PROBES /health any more (row notes may still narrate why it died).
    const probeUrls = LANES.flatMap((l) => (l.probe?.kind === 'http' ? [l.probe.url] : []));
    expect(probeUrls.filter((u) => u.includes('/health'))).toEqual([]);
  });

  it('records the child-session trap on the MCP pool lane as data', () => {
    // Observed 2026-08-18: the lane spawns claude.exe -p with the repo as cwd
    // and no AUDIT_TOOLS_CHILD_SESSION=1, so the child self-registers as owner
    // and its Stop closeout-challenge replaces the final answer.
    expect(laneById('mcp-pool').note).toMatch(/AUDIT_TOOLS_CHILD_SESSION=1/);
  });
});

// ── classification: the catch-all false green is dead ────────────────────────

describe('classifyHttpProbe', () => {
  const routerProbe: HttpProbe = {
    kind: 'http',
    url: 'http://127.0.0.1:3001/v1/models',
    timeoutMs: 2_000,
    upStatuses: [200, 401],
    requireJsonOn: [200],
  };

  it('classifies a catch-all 200 text/html as DOWN — the vacuous-probe shape (P36 RED a)', () => {
    expect(classifyHttpProbe(routerProbe, { statusCode: 200, contentType: 'text/html; charset=utf-8' })).toBe(false);
  });

  it('classifies 401 as UP on status alone — "up, key wrong" is a different failure', () => {
    expect(classifyHttpProbe(routerProbe, { statusCode: 401, contentType: 'text/html' })).toBe(true);
  });

  it('classifies 200 application/json as UP — the API surface answered', () => {
    expect(classifyHttpProbe(routerProbe, { statusCode: 200, contentType: 'application/json; charset=utf-8' })).toBe(
      true,
    );
  });

  it('classifies non-up statuses and a missing status as DOWN', () => {
    expect(classifyHttpProbe(routerProbe, { statusCode: 500, contentType: 'application/json' })).toBe(false);
    expect(classifyHttpProbe(routerProbe, { statusCode: 404, contentType: 'application/json' })).toBe(false);
    expect(classifyHttpProbe(routerProbe, { statusCode: undefined, contentType: undefined })).toBe(false);
  });

  it('without requireJsonOn, an up status passes on status alone (the headroom /stats shape)', () => {
    const stats: HttpProbe = { kind: 'http', url: 'http://x/stats', timeoutMs: 2_000, upStatuses: [200] };
    expect(classifyHttpProbe(stats, { statusCode: 200, contentType: 'text/html' })).toBe(true);
  });
});

// ── probeLane against real sockets ───────────────────────────────────────────

describe('probeLane', () => {
  const router = () => laneById('freellmapi-router');

  it('classifies the real-router shape UP via the env override', async () => {
    const base = await realRouter();
    const env = { AUDIT_TOOLS_OFFLOAD_PROBE_URL: `${base}/v1/models` };
    await expect(probeLane(router(), env)).resolves.toBe(true);
  });

  it('classifies the all-200 catch-all DOWN — a listening web server is not a live API', async () => {
    const base = await catchAll();
    const env = { AUDIT_TOOLS_OFFLOAD_PROBE_URL: `${base}/v1/models` };
    await expect(probeLane(router(), env)).resolves.toBe(false);
  });

  it('classifies a refused connection DOWN', async () => {
    await expect(probeLane(router(), { AUDIT_TOOLS_OFFLOAD_PROBE_URL: CLOSED })).resolves.toBe(false);
  });

  it('runs the command probe: exit 0 = up, missing binary = down, "skip" = unprobed', async () => {
    const agy = laneById('agy-cli');
    // node --version: sub-second exit 0 on every platform the suite runs on.
    await expect(probeLane(agy, { AUDIT_TOOLS_AGY_PROBE_CMD: process.execPath })).resolves.toBe(true);
    await expect(probeLane(agy, { AUDIT_TOOLS_AGY_PROBE_CMD: 'definitely-not-a-command-xyz' })).resolves.toBe(false);
    await expect(probeLane(agy, { AUDIT_TOOLS_AGY_PROBE_CMD: 'skip' })).resolves.toBe(null);
  });

  it('returns null for a declared-unprobeable lane — silence, not a guess', async () => {
    await expect(probeLane(laneById('mcp-pool'), {})).resolves.toBe(null);
  });
});

// ── reconcile(): synthetic registries, one mutation per case ─────────────────

const HEALTHY_HOOK = "import { OFFLOAD_LANES, probeLane } from '../../scripts/shared/offload-lane-data.mjs';";
const healthyLanes = (): LaneRow[] => [
  {
    id: 'alpha',
    kind: 'router',
    label: 'alpha lane',
    transport: 'loopback :1',
    probe: { kind: 'http', url: 'http://127.0.0.1:1/v1/models', timeoutMs: 1_000, upStatuses: [200, 401], requireJsonOn: [200] },
    envOverride: 'ALPHA_URL',
    configDirTrust: null,
    trustUncheckableReason: 'synthetic lane',
    remedy: 'start alpha',
  },
  {
    id: 'beta',
    kind: 'peer-cli',
    label: 'beta lane',
    transport: 'client-bound',
    probe: null,
    unprobeableReason: 'nothing listens',
    configDirTrust: null,
    trustUncheckableReason: 'synthetic lane',
    remedy: 'reinstall beta',
  },
];
const healthyArgs = (): ReconcileArgs => ({
  lanes: healthyLanes(),
  markers: [{ marker: 'alpha lane', laneId: 'alpha' }],
  hookSource: HEALTHY_HOOK,
  docTexts: { 'docs/one.md': 'the alpha lane is a lane' },
});
const run = (over: Partial<ReconcileArgs> = {}) => reconcile({ ...healthyArgs(), ...over });

describe('check-offload-lanes reconcile()', () => {
  it('a healthy registry reconciles clean', () => {
    expect(run()).toEqual([]);
  });

  it('fails an empty registry — probing nothing must not read as coverage', () => {
    expect(run({ lanes: [], markers: [] }).join('\n')).toMatch(/No lanes declared/);
  });

  it('fails a duplicate lane id', () => {
    const lanes = healthyLanes();
    lanes.push({ ...lanes[1], envOverride: undefined });
    expect(run({ lanes }).join('\n')).toMatch(/Duplicate lane id "beta"/);
  });

  it('fails an http probe without upStatuses — it could never classify up', () => {
    const lanes = healthyLanes();
    (lanes[0].probe as HttpProbe).upStatuses = [];
    expect(run({ lanes }).join('\n')).toMatch(/non-empty upStatuses/);
  });

  it('fails an unbounded probe — a probe that can hang the hook is worse than none', () => {
    const lanes = healthyLanes();
    (lanes[0].probe as HttpProbe).timeoutMs = 0;
    expect(run({ lanes }).join('\n')).toMatch(/positive timeoutMs/);
  });

  it('fails a null probe with no unprobeableReason — unprobeable is a statement, never silence', () => {
    const lanes = healthyLanes();
    delete lanes[1].unprobeableReason;
    expect(run({ lanes }).join('\n')).toMatch(/no unprobeableReason/);
  });

  it('fails a row carrying BOTH a probe and an unprobeableReason', () => {
    const lanes = healthyLanes();
    lanes[0].unprobeableReason = 'but it is probed';
    expect(run({ lanes }).join('\n')).toMatch(/contradictory/);
  });

  it('fails a missing remedy — a down lane must be actionable', () => {
    const lanes = healthyLanes();
    lanes[0].remedy = '';
    expect(run({ lanes }).join('\n')).toMatch(/missing remedy/);
  });

  it('fails two rows claiming one envOverride — one test override would redirect two lanes', () => {
    const lanes = healthyLanes();
    lanes[1] = { ...lanes[1], probe: { kind: 'command', command: 'beta', args: [], timeoutMs: 1_000 }, envOverride: 'ALPHA_URL' };
    delete lanes[1].unprobeableReason;
    expect(run({ lanes }).join('\n')).toMatch(/claimed by both/);
  });

  it('fails a hook that does not reference the registry', () => {
    expect(run({ hookSource: 'const nothing = 1;' }).join('\n')).toMatch(/not iterating the registry/);
  });

  it("fails a hook containing the retired '/health' literal — the vacuous probe is pinned out forever", () => {
    expect(run({ hookSource: `${HEALTHY_HOOK}\nconst u = '/health';` }).join('\n')).toMatch(/vacuous/);
  });

  it('fails a hook containing any hardcoded URL — lane endpoints live only in the registry', () => {
    expect(run({ hookSource: `${HEALTHY_HOOK}\nconst u = 'http://127.0.0.1:3001';` }).join('\n')).toMatch(
      /hardcoded URL/,
    );
  });

  it('fails a doc marker citing a lane with no row — a documented lane cannot be silently unprobed', () => {
    expect(run({ markers: [{ marker: 'alpha lane', laneId: 'gone' }] }).join('\n')).toMatch(/has no row/);
  });

  it('fails a doc marker no scanned doc contains — registry rot', () => {
    expect(run({ markers: [{ marker: 'vanished lane', laneId: 'alpha' }] }).join('\n')).toMatch(/no scanned doc/);
  });
});

// ── the LIVE registry reconciles against the LIVE tree ───────────────────────

describe('live reconciliation', () => {
  it('the shipped registry, hook and tracked docs reconcile clean', () => {
    const docTexts: Record<string, string> = {};
    for (const doc of SCANNED_DOCS) docTexts[doc] = readFileSync(join(REPO_ROOT, doc), 'utf8');
    expect(
      reconcile({ lanes: LANES, markers: MARKERS, hookSource: readFileSync(GUARDS, 'utf8'), docTexts }),
    ).toEqual([]);
  });
});

// ── the hook leg end-to-end ──────────────────────────────────────────────────

const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows lock — leave it to the temp reaper */
    }
  }
});

// ASYNC on purpose: the fake lane servers run in THIS process's event loop,
// and a spawnSync would block it — the child's probes would then time out
// against a server that can never answer, classifying every lane down.
function runGuards(env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'laneprobe-'));
  scratches.push(scratch);
  const inherited = { ...process.env };
  delete inherited.AUDIT_TOOLS_CHILD_SESSION;
  return new Promise((done, fail) => {
    const child = spawnHidden(process.execPath, [GUARDS], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      env: {
        ...inherited,
        CLAUDE_PROJECT_DIR: scratch,
        AUDIT_TOOLS_AGY_PROBE_CMD: 'skip',
        // The trust checks read the LOCAL config dir; skip them unless a case
        // points them at a scratch one, or the suite would depend on this
        // machine's freellmapi install.
        AUDIT_TOOLS_POOL_TRUST_DIR: 'skip',
        AUDIT_TOOLS_LAUNCHER_TRUST_DIR: 'skip',
        ...env,
      },
    });
    child.stdin?.end();
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout }));
  });
}

describe('session-start-guards lane leg (end-to-end)', () => {

  it('names EVERY down lane with its remedy — including a catch-all 200 router (the old false green)', async () => {
    const base = await catchAll();
    const pass = await runGuards({
      // The vacuous-probe shape: a web server answers 200 on the probed path,
      // but the API surface is gone. The retired leg classified this UP.
      AUDIT_TOOLS_OFFLOAD_PROBE_URL: `${base}/v1/models`,
      AUDIT_TOOLS_HEADROOM_PROBE_URL: CLOSED,
    });
    expect(pass.code).toBe(0); // a probe must never block a session
    expect((pass.stdout.match(/OFFLOAD LANE DOWN/g) ?? []).length).toBe(2);
    expect(pass.stdout).toContain('start.ps1'); // the router row's remedy
    expect(pass.stdout).toContain('wscript.exe'); // the codex/headroom row's remedy
  });

  it('is silent about lanes that are up or declared unprobeable', async () => {
    const routerBase = await realRouter();
    const statsBase = await catchAll(); // /stats shape: 200 on status alone is up
    const pass = await runGuards({
      AUDIT_TOOLS_OFFLOAD_PROBE_URL: `${routerBase}/v1/models`,
      AUDIT_TOOLS_HEADROOM_PROBE_URL: `${statsBase}/stats`,
    });
    expect(pass.code).toBe(0);
    expect(pass.stdout).not.toContain('OFFLOAD LANE DOWN');
  });
});

// ── P43: workspace trust of a lane's isolated config dir ─────────────────────
// The defect class: a Claude lane launched with an isolated CLAUDE_CONFIG_DIR
// that has not trusted this workspace does not error — it runs with no repo
// tools and answers from nothing, with the right structure and fabricated
// supporting quotes (2026-08-07/13/14/15). The precondition is deterministic
// and readable BEFORE dispatch, so it costs no quota.

describe('configDirTrust registry shape', () => {
  it('every lane row ANSWERS the trust question — a check, or a stated reason it is uncheckable', () => {
    for (const lane of LANES) {
      expect(Object.hasOwn(lane, 'configDirTrust'), `lane "${lane.id}" declares no configDirTrust`).toBe(true);
      if (lane.configDirTrust === null) {
        expect(lane.trustUncheckableReason, `lane "${lane.id}"`).toBeTruthy();
      } else {
        expect(lane.configDirTrust.configDir, `lane "${lane.id}"`).toBeTruthy();
        expect(lane.configDirTrust.untrustedRemedy, `lane "${lane.id}"`).toBeTruthy();
      }
    }
  });

  it('declares the trust check on BOTH lanes that launch claude.exe with the isolated pool config dir', () => {
    for (const id of ['mcp-pool', 'claude-ps1-launcher']) {
      const trust = laneById(id).configDirTrust;
      expect(trust, `lane "${id}" must check workspace trust`).not.toBeNull();
      expect(trust?.configDir).toMatch(/claude-config/);
    }
  });

  it('marks the inlined-content lanes uncheckable so they can never red falsely', () => {
    for (const id of ['agy-cli', 'codex-cli', 'mcp-agy-recon', 'mcp-codex-recon']) {
      expect(laneById(id).configDirTrust, `lane "${id}"`).toBeNull();
      expect(laneById(id).trustUncheckableReason, `lane "${id}"`).toBeTruthy();
    }
  });
});

describe('classifyConfigDirTrust', () => {
  const WS = 'C:/Code/audit-tools';
  const config = (projects: Record<string, unknown>) => JSON.stringify({ projects });

  it('is TRUSTED only when the workspace itself carries hasTrustDialogAccepted', () => {
    expect(classifyConfigDirTrust(config({ [WS]: { hasTrustDialogAccepted: true } }), WS)).toBe(true);
  });

  it('is UNTRUSTED when a PARENT path is trusted — trust is not inherited (the 2026-08-15 cause)', () => {
    expect(classifyConfigDirTrust(config({ 'C:/Code': { hasTrustDialogAccepted: true } }), WS)).toBe(false);
  });

  it('is UNTRUSTED when the entry exists but the flag is absent or false', () => {
    expect(classifyConfigDirTrust(config({ [WS]: {} }), WS)).toBe(false);
    expect(classifyConfigDirTrust(config({ [WS]: { hasTrustDialogAccepted: false } }), WS)).toBe(false);
  });

  it('matches across separator and drive-letter case — the same workspace either spelling', () => {
    const backslashed = { 'c:\\Code\\audit-tools': { hasTrustDialogAccepted: true } };
    expect(classifyConfigDirTrust(config(backslashed), WS)).toBe(true);
  });

  it('answers UNKNOWN (null), never a guess, for an unreadable or projects-less config', () => {
    expect(classifyConfigDirTrust('{not json', WS)).toBe(null);
    expect(classifyConfigDirTrust('{}', WS)).toBe(null);
  });
});

describe('checkLaneTrust', () => {
  const scratchDirs: string[] = [];
  afterAll(() => {
    for (const dir of scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows lock — leave it to the temp reaper */
      }
    }
  });
  const scratchTrust = (projects: Record<string, unknown>) => {
    const dir = trustDir(projects);
    scratchDirs.push(dir);
    return dir;
  };
  const pool = () => laneById('mcp-pool');
  const envVar = () => {
    const trust = pool().configDirTrust;
    if (trust === null) throw new Error('mcp-pool declares no trust check');
    return trust.envOverride;
  };

  it('reads the override config dir: workspace listed = trusted, absent = UNTRUSTED', async () => {
    const yes = scratchTrust({ 'C:/Code/audit-tools': { hasTrustDialogAccepted: true } });
    const no = scratchTrust({ 'C:/Code': { hasTrustDialogAccepted: true } });
    await expect(checkLaneTrust(pool(), 'C:/Code/audit-tools', { [envVar()]: yes })).resolves.toBe(true);
    await expect(checkLaneTrust(pool(), 'C:/Code/audit-tools', { [envVar()]: no })).resolves.toBe(false);
  });

  it('answers null for a config dir that does not exist — a missing install must not red the lane', async () => {
    const gone = join(tmpdir(), 'lanetrust-definitely-absent-xyz');
    await expect(checkLaneTrust(pool(), 'C:/Code/audit-tools', { [envVar()]: gone })).resolves.toBe(null);
  });

  it('answers null for "skip" and for a lane declared uncheckable', async () => {
    await expect(checkLaneTrust(pool(), 'C:/Code/audit-tools', { [envVar()]: 'skip' })).resolves.toBe(null);
    await expect(checkLaneTrust(laneById('codex-cli'), 'C:/Code/audit-tools', {})).resolves.toBe(null);
  });
});

describe('check-offload-lanes reconcile() — configDirTrust', () => {
  const withTrust = (over: Partial<ConfigDirTrust> | null, extra: Partial<LaneRow> = {}): LaneRow[] => {
    const lanes = healthyLanes();
    lanes[0] = {
      ...lanes[0],
      trustUncheckableReason: over === null ? 'synthetic lane' : undefined,
      configDirTrust:
        over === null
          ? null
          : { configDir: 'C:/tmp/alpha-config', envOverride: 'ALPHA_TRUST_DIR', untrustedRemedy: 'trust it', ...over },
      ...extra,
    };
    return lanes;
  };

  it('a registry declaring trust on one row and a reason on the other reconciles clean', () => {
    expect(run({ lanes: withTrust({}) })).toEqual([]);
  });

  it('fails a row that never answers the trust question', () => {
    const lanes = healthyLanes();
    delete (lanes[0] as Partial<LaneRow>).configDirTrust;
    expect(run({ lanes }).join('\n')).toMatch(/configDirTrust/);
  });

  it('fails a null configDirTrust with no trustUncheckableReason — uncheckable is a statement', () => {
    const lanes = withTrust(null, { trustUncheckableReason: undefined });
    expect(run({ lanes }).join('\n')).toMatch(/trustUncheckableReason/);
  });

  it('fails a row carrying BOTH a trust check and a trustUncheckableReason', () => {
    expect(run({ lanes: withTrust({}, { trustUncheckableReason: 'but it is checked' }) }).join('\n')).toMatch(
      /contradictory/,
    );
  });

  it('fails a trust check with a relative configDir — the hook resolves nothing', () => {
    expect(run({ lanes: withTrust({ configDir: 'claude-config' }) }).join('\n')).toMatch(/absolute/);
  });

  it('fails a trust check with no untrustedRemedy — an unusable lane must be actionable', () => {
    expect(run({ lanes: withTrust({ untrustedRemedy: '' }) }).join('\n')).toMatch(/untrustedRemedy/);
  });

  it('fails a trust envOverride colliding with a probe envOverride — one var would redirect two things', () => {
    expect(run({ lanes: withTrust({ envOverride: 'ALPHA_URL' }) }).join('\n')).toMatch(/claimed by both/);
  });
});

describe('session-start-guards trust leg (end-to-end)', () => {
  const scratchDirs: string[] = [];
  afterAll(() => {
    for (const dir of scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows lock — leave it to the temp reaper */
      }
    }
  });

  it('names an untrusted lane UNUSABLE with its remedy, and is silent when the check is skipped', async () => {
    const untrusted = trustDir({ 'C:/Code': { hasTrustDialogAccepted: true } });
    scratchDirs.push(untrusted);
    const routerBase = await realRouter();
    const statsBase = await catchAll();
    const upEnv = {
      AUDIT_TOOLS_OFFLOAD_PROBE_URL: `${routerBase}/v1/models`,
      AUDIT_TOOLS_HEADROOM_PROBE_URL: `${statsBase}/stats`,
    };

    const red = await runGuards({
      ...upEnv,
      AUDIT_TOOLS_POOL_TRUST_DIR: untrusted,
      AUDIT_TOOLS_LAUNCHER_TRUST_DIR: untrusted,
    });
    expect(red.code).toBe(0); // reporting a lane unusable must never block a session
    expect((red.stdout.match(/OFFLOAD LANE UNUSABLE/g) ?? []).length).toBe(2);
    expect(red.stdout).toContain('hasTrustDialogAccepted');

    const green = await runGuards(upEnv); // runGuards skips the trust checks by default
    expect(green.stdout).not.toContain('OFFLOAD LANE UNUSABLE');
  });
});
