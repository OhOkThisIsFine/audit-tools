#!/usr/bin/env node
/**
 * configure-9router.mjs — create the task-class routing combos in a running 9router.
 *
 * YOU run this (it never sees your password from anyone but you):
 *   NINEROUTER_PASSWORD='your-dashboard-password' node examples/configure-9router.mjs
 *
 * Options (env):
 *   NINEROUTER_URL       base url (default http://127.0.0.1:20128)
 *   NINEROUTER_PASSWORD  your dashboard password (required)
 *   DRY_RUN=1            print what would be created, change nothing
 *
 * What it does: logs in → reads connected models → creates any missing combos below.
 * A combo referencing a not-yet-connected model is harmless — it lights up once you
 * connect that provider in the dashboard. It does NOT connect providers or touch
 * credentials; provider OAuth/token-import stays a conscious dashboard action.
 *
 * Combos = the shared vocabulary between host-LLM routing judgment and 9router's
 * reactive fallback (see docs/reviews/host-routed-dispatch-design-2026-07-23.md).
 * Each combo is an ORDERED preference list: primary first, fallbacks after. Edit the
 * ids to match your connected models (dashboard → Providers shows the exact `prefix/id`).
 */

const BASE = (process.env.NINEROUTER_URL || 'http://127.0.0.1:20128').replace(/\/$/, '');
const PASSWORD = process.env.NINEROUTER_PASSWORD || '';
const DRY_RUN = process.env.DRY_RUN === '1';

// ─── Task-class combos (edit ids to match your connected providers) ───────────
// prefixes: cc/=Claude sub · cx/=Codex sub · kr/=Kiro (free) · verify others in dashboard.
// NIM/Gemini-Flash ids are commented until you connect them (native provider, or a
// custom OpenAI-compatible node pointed at your LiteLLM at 127.0.0.1:4000).
// These are the combos actually created live on 2026-07-23 against the connected roster.
// Reorder/edit freely (dashboard → Combos supports drag-and-drop).
const COMBOS = [
  { name: 'heavy-reason',  // high importance / high complexity
    models: ['cc/claude-opus-4-8', 'cx/gpt-5.6-sol', 'nvidia/z-ai/glm-5.2', 'ds/deepseek-v4-pro-max', 'kr/claude-sonnet-4.5-thinking'] },
  { name: 'standard-code', // normal dev work
    models: ['cc/claude-sonnet-5', 'cx/gpt-5.5', 'ag/claude-sonnet-4-6', 'nvidia/deepseek-ai/deepseek-v4-pro', 'kr/claude-sonnet-4.5'] },
  { name: 'cheap-bulk',    // recon / extraction / low-importance, high-volume
    models: ['ag/gemini-3-flash', 'nvidia/minimaxai/minimax-m3', 'ocg/glm-5.2', 'kr/glm-5', 'groq/llama-3.3-70b-versatile'] },
  { name: 'free-only',     // zero-cost lane (no subscription models)
    models: ['kr/claude-sonnet-4.5', 'kr/glm-5', 'ocg/deepseek-v4-pro', 'cf/@cf/zai-org/glm-4.7-flash', 'groq/openai/gpt-oss-120b', 'ollama/glm-5'] },
  { name: 'codex-lane',    // when you specifically want Codex
    models: ['cx/gpt-5.6-sol', 'cx/gpt-5.5', 'cx/gpt-5.4', 'cc/claude-sonnet-5'] },
  { name: 'nim-lane',      // NIM roster — capable + effectively free, spares subscription quota
    models: ['nvidia/z-ai/glm-5.2', 'nvidia/deepseek-ai/deepseek-v4-pro', 'nvidia/minimaxai/minimax-m3', 'nvidia/nemotron-3-ultra-550b-a55b', 'ocg/glm-5.2'] },
];
// ──────────────────────────────────────────────────────────────────────────────

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) die(`login failed (HTTP ${res.status}) — check NINEROUTER_PASSWORD and that 9router is up at ${BASE}`);
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  const auth = setCookie.map(c => c.split(';')[0]).find(c => c.startsWith('auth_token='));
  if (!auth) die('login returned no auth_token cookie');
  return auth;
}

async function api(path, cookie, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers || {}) },
  });
  return res;
}

async function main() {
  if (!PASSWORD) die("set NINEROUTER_PASSWORD to your dashboard password (this script never stores or transmits it anywhere but your local 9router).");
  const cookie = await login();
  console.log(`✓ authenticated to ${BASE}`);

  // known model ids (best-effort; a miss just means "connect that provider")
  let known = new Set();
  try {
    const m = await (await api('/v1/models', cookie)).json();
    known = new Set((m.data || []).map(x => x.id));
  } catch { /* non-fatal */ }

  const existing = new Set((await (await api('/api/combos', cookie)).json()).combos?.map(c => c.name) || []);

  for (const combo of COMBOS) {
    const present = combo.models.filter(id => known.has(id));
    const missing = combo.models.filter(id => !known.has(id));
    const tag = missing.length ? `  (not yet connected: ${missing.join(', ')})` : '';
    if (existing.has(combo.name)) { console.log(`• ${combo.name} — exists, skipping${tag}`); continue; }
    if (DRY_RUN) { console.log(`• ${combo.name} — would create [${combo.models.join(' → ')}]${tag}`); continue; }
    const res = await api('/api/combos', cookie, { method: 'POST', body: JSON.stringify({ name: combo.name, models: combo.models }) });
    if (res.status === 201) console.log(`✓ ${combo.name} — created [${combo.models.join(' → ')}]${tag}`);
    else console.log(`✗ ${combo.name} — HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }
  console.log(DRY_RUN ? '\n(dry run — nothing changed)' : '\nDone. Point a client at a combo by name, e.g. model = "heavy-reason".');
}

main().catch(e => die(e.message));
