#!/usr/bin/env node
// Mechanically triage every backlog entry through the offload lane — one entry,
// one call.
//
// WHY THIS EXISTS. The backlog is ~100 entries of dense prose, and its own
// standing rule is that an entry's premise must be verified against HEAD before
// a lap opens on it ([[backlog-prose-decays-verify-against-head]]). Doing that by
// reading the whole file costs the main context the entries were split to save,
// and a 2026-07-19 pass found ~21% of entries were already shipped or stale. This
// routes the classification to the local proxy instead, so a lap starts from a
// routing map rather than from a blind read.
//
// OUTPUT IS ADVISORY, NEVER A VERDICT. The lane over-flags
// `owner_decision_needed` — its habitual hedge is "schedule a discussion with
// the owner" — and the 2026-07-25 run classified three already-fixed entries as
// actionable. Verify a row against HEAD before working it.
//
//   node scripts/shared/triage-backlog.mjs [outPath]
//
// Resumable: completed ids are read back from the JSONL and skipped, so a killed
// run continues rather than restarting. Errored rows are dropped from the file
// on load and their entries re-queued, so a plain re-run retries exactly the
// failures — no hand-editing of the JSONL.
//
// Entry ids are CONTENT-derived (`<file>#<hash8>` over the normalized entry
// text), never positional: leg 2 exists to DELETE entries from these files, and
// a positional id makes every later row name a different entry after a deletion.
// An edited entry changes its id and is re-triaged, which is correct — the old
// verdict was about text that no longer exists.
//
// PREMISE PROBES (determination ea4e616f). Each verdict carries
// `premise_probes` — literal strings the ENTRY quotes, tied to the paths it
// names. The model only ever sees the entry text, so the probes are the
// entry's own claims; THIS script holds the repo access and evaluates them
// mechanically, stamping `premise: holds|partial|gone|unprobed` on every
// record. Every invocation also RE-evaluates the stored records first —
// regenerating the triage is the presentation event for this lifecycle, so a
// record whose quoted code has since vanished reads `premise: "gone"` rather
// than surviving as a stale verdict.
//
//   TRIAGE_MODEL=<spec>        explicit llm-relay spec (pool/<name> or
//                              <provider>/<model>). DEFAULT IS DISCOVERED LIVE:
//                              the script asks `llm-relay config get
//                              routing.pools` and picks medium > low > high >
//                              xhigh — a hardcoded pool name is a hand-held
//                              copy of the relay's config and went stale twice
//                              (pool/fast + pool/coding died at relay v0.15.4).
//   TRIAGE_CONCURRENCY=<n>     default 3
//
// HEALTH CONTRACT (P11, owner decision sol-4 2026-08-06). Three consecutive
// nights degraded silently to a partial sweep, each for a different transport
// fault. Now: (1) the model target is resolved live (above) and an unresolvable
// lane ABORTS at startup naming the escape; (2) one PREFLIGHT call runs before
// the sweep — a dead lane fails loudly at entry 0, not silently at entry 154
// (single attempt, matching the per-entry policy: failover is the relay's job);
// (3) a COVERAGE STAMP (<out>-coverage.json) records model/attempted/
// classified/errored/aborted, rewritten as the sweep progresses, so "did leg 2
// actually cover the backlog" is a number the routine reads, never a wc -l.
//
// ⚠ ALIAS CHOICE IS THE WHOLE COST. `glm-5.2` (rank 1) spent ~4 min per entry on
// this — ~7h for the file — because it is a heavy reasoning model doing a
// mechanical classification. The flash tier answers in seconds. Conversely
// `deepseek-v4-flash` prepends prose before the JSON despite `response_format`,
// which is why the extractor below salvages the object rather than trusting the
// body to be bare JSON. [[offload-lane-failures-are-usually-the-caller]]
//
// ⚠ The schema is shaped to THIS task (a verdict enum plus an action), not the
// lane's generic {summary, findings[], open_questions[]} container. A misfitting
// schema does not error; it returns valid JSON full of placeholders that reads as
// model incapacity.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateProbes } from '../nightly/items.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] || join(ROOT, '.audit-tools', 'backlog-triage.jsonl');
const CONCURRENCY = Number(process.env.TRIAGE_CONCURRENCY || 3);

// llm-relay on :8791 — the LiteLLM proxy this script was born against (:4000)
// was retired 2026-07-28, which left the whole lane dead transport.

function defaultPoolsCli() {
  // shell:true so the platform shim (.cmd on Windows) resolves — the same
  // reason product spawns route through resolveWindowsShimSpawnCommand.
  const r = spawnSync('llm-relay config get routing.pools', {
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  if (r.error || r.status !== 0) {
    throw new Error(r.error?.message || (r.stderr || '').trim() || `llm-relay exited ${r.status}`);
  }
  return r.stdout;
}

/**
 * Resolve the model spec: an explicit TRIAGE_MODEL wins verbatim; otherwise the
 * live pool roster is asked for. Never a hardcoded pool name — the relay owns
 * its roster and renames it without telling this script.
 */
export function resolveTriageModel(env = process.env, poolsCli = defaultPoolsCli) {
  const explicit = env.TRIAGE_MODEL;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  let raw;
  try {
    raw = poolsCli();
  } catch (err) {
    throw new Error(
      `triage lane cannot resolve a model target: llm-relay pool discovery failed ` +
        `(${err?.message ?? err}). The lane is DEAD, not slow — fix the relay or set ` +
        `TRIAGE_MODEL=<spec> to bypass discovery.`,
    );
  }
  let pools;
  try {
    pools = JSON.parse(raw);
  } catch {
    throw new Error(
      `triage lane cannot resolve a model target: llm-relay returned unparseable pool config ` +
        `(${String(raw).slice(0, 120)}). Set TRIAGE_MODEL=<spec> to bypass discovery.`,
    );
  }
  const names = Object.keys(pools ?? {});
  if (names.length === 0) {
    throw new Error(
      'triage lane cannot resolve a model target: llm-relay reports no configured pools. ' +
        'Set TRIAGE_MODEL=<spec> to bypass discovery.',
    );
  }
  // Mechanical classification wants the flash tier (the header notes measure a
  // heavy reasoner at ~4min/entry vs seconds): medium first, then cheaper, then
  // heavier, then whatever the roster offers.
  const preferred = ['medium', 'low', 'high', 'xhigh'].find((n) => names.includes(n)) ?? names[0];
  return `pool/${preferred}`;
}

/** `<out minus .jsonl>-coverage.json` — the leg-2 coverage stamp sidecar. */
export function coverageStampPath(outPath) {
  return outPath.replace(/\.jsonl$/, '') + '-coverage.json';
}

export function writeCoverageStamp(path, stamp) {
  fs.writeFileSync(path, JSON.stringify(stamp, null, 2) + '\n');
}

// Map the shared evaluator's item-level view onto a per-record stamp. `partial`
// is surfaced separately from `holds` because a half-vanished premise is
// exactly the "verify against HEAD before working it" case. A row whose every
// probe is signal-free (bad_path / unknown / error — the model emits bare
// filenames it cannot resolve) stamps `unprobed`, never `gone`: a malformed
// probe must not manufacture the strongest possible claim (nightly sol-3).
function premiseStamp(rec) {
  const { status, probes } = evaluateProbes(ROOT, rec);
  if (status === 'unprobed') return 'unprobed';
  if (status === 'resolved') return 'gone';
  const signalFree = new Set(['bad_path', 'unknown', 'error', 'untrackable']);
  if (probes.every((p) => signalFree.has(p.state))) return 'unprobed';
  return probes.some((p) => p.state === 'absent') ? 'partial' : 'holds';
}

function chunk(file) {
  const text = fs.readFileSync(join(ROOT, 'docs', 'backlog', file), 'utf8');
  const lines = text.split(/\r?\n/);
  const entries = [];
  let cur = null;
  for (const l of lines) {
    if (/^- \*\*/.test(l)) { if (cur) entries.push(cur); cur = { file, body: [l] }; }
    else if (cur) cur.body.push(l);
  }
  if (cur) entries.push(cur);
  return entries.map((e) => {
    const text = e.body.join('\n').trim();
    // Normalize whitespace so a reflow alone does not re-triage the entry.
    const hash = createHash('sha256').update(text.replace(/\s+/g, ' ')).digest('hex').slice(0, 8);
    return { id: `${file.replace('.md', '')}#${hash}`, file, text };
  });
}

const entries = [...chunk('open-bugs.md'), ...chunk('forward-tracks.md'), ...chunk('deferred.md')];

const SCHEMA = {
  name: 'backlog_triage',
  strict: false,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'verdict', 'why', 'action', 'effort', 'code_paths', 'premise_probes'],
    properties: {
      title: { type: 'string', description: 'the entry title, condensed to <=90 chars' },
      verdict: {
        type: 'string',
        enum: [
          'actionable_now',
          'owner_decision_needed',
          'live_run_blocked',
          'accepted_residual_no_work',
          'already_shipped_or_stale',
        ],
      },
      why: { type: 'string', description: 'one sentence justifying the verdict, quoting the entry' },
      action: { type: 'string', description: 'the single concrete change to make, or the exact question to ask the owner' },
      effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
      code_paths: { type: 'array', items: { type: 'string' }, description: 'source paths the entry names' },
      premise_probes: {
        type: 'array',
        description:
          'literal strings the ENTRY quotes as existing in the tree, each tied to the repo-relative path the entry names for it; empty only when the entry quotes nothing checkable',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['file', 'contains'],
          properties: {
            file: { type: 'string', description: 'repo-relative path the entry names' },
            contains: { type: 'string', description: 'a literal fragment the entry quotes from that file' },
          },
        },
      },
    },
  },
};

const SYS = `You triage backlog entries for a TypeScript repo. Classify ONE entry.

Verdicts:
- actionable_now: a concrete code/doc change is derivable from the entry text alone, needing no owner judgment and no live-run evidence.
- owner_decision_needed: the entry states an open question only the project owner can settle (a design/policy choice, a preference, a scope call). If the entry already records an "OWNER DECISION", it is NOT this — it is actionable_now.
- live_run_blocked: marked LIVE / live-run watch / blocked on evidence from a real run, or explicitly "revisit on live evidence only".
- accepted_residual_no_work: the entry explicitly says the residual is ACCEPTED and no work is wanted.
- already_shipped_or_stale: the entry says the mechanism SHIPPED / was REFUTED / FALSIFIED with nothing left open.

Be strict. Prefer actionable_now when a property to hold is stated and the fix site is named.

premise_probes: for each code fragment the entry QUOTES as currently existing (a symbol, a string, a
line), emit { file, contains } with the repo-relative path the entry ties it to. Quote the fragment
VERBATIM from the entry — you cannot see the repo, so never invent content. Prefer fragments whose
disappearance would mean the entry is done. Emit [] only when the entry quotes nothing checkable.`;

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: 8791, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch (e) { reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 400)}`)); }
        });
      },
    );
    req.setTimeout(20 * 60 * 1000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  let MODEL;
  const stampPath = coverageStampPath(OUT);
  // Best-effort telemetry: a failed stamp write (missing dir, locked file) must
  // never mask the real abort message or kill a healthy sweep.
  let stampWarned = false;
  const stampSafe = (data) => {
    try {
      writeCoverageStamp(stampPath, data);
    } catch (err) {
      if (!stampWarned) {
        stampWarned = true;
        process.stderr.write(`coverage stamp not writable (${err?.message ?? err}) — continuing without it\n`);
      }
    }
  };
  try {
    MODEL = resolveTriageModel();
  } catch (err) {
    stampSafe({
      model: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      aborted: String(err.message || err),
      total_entries: entries.length,
      prior_classified: 0,
      attempted: 0,
      classified: 0,
      errored: 0,
    });
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }

  // Re-evaluate the premise of every stored record before doing anything else:
  // running this script IS the presentation event for triage verdicts, so a
  // record whose quoted code vanished since the last run must read
  // `premise: "gone"` now, not carry last week's stamp.
  const done = new Set();
  if (fs.existsSync(OUT)) {
    const kept = [];
    for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const rec = JSON.parse(l);
        // Errored rows are DROPPED and their entries re-queued: an id in `done`
        // means a verdict exists, never that an attempt happened. (The old
        // behaviour added errored ids too, so a re-run retried nothing and
        // exited 0 — a false green.)
        if (rec.error) continue;
        done.add(rec.id);
        kept.push({ ...rec, premise: premiseStamp(rec) });
      } catch {}
    }
    fs.writeFileSync(OUT, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
  }

  const queue = entries.filter((e) => !done.has(e.id));
  const stamp = {
    model: MODEL,
    started_at: new Date().toISOString(),
    finished_at: null,
    aborted: null,
    total_entries: entries.length,
    prior_classified: done.size,
    attempted: 0,
    classified: 0,
    errored: 0,
  };
  stampSafe(stamp);

  // Preflight: one call before the sweep, SINGLE attempt (matching the
  // per-entry no-retry policy — failover is the relay's job). A dead lane must
  // fail loudly at entry 0, with the relay's own message, not silently at
  // entry 154.
  try {
    const { status, body: r } = await post({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    if (r?.error || !Array.isArray(r?.choices)) {
      const msg = r?.error?.message ?? JSON.stringify(r).slice(0, 400);
      throw new Error(`HTTP ${status} ${r?.error?.code ?? r?.error?.type ?? ''}: ${msg}`.trim());
    }
  } catch (err) {
    stamp.aborted = `preflight failed: ${String(err.message || err)}`;
    stampSafe(stamp);
    process.stderr.write(
      `${stamp.aborted}\nThe lane is DEAD, not slow — nothing was attempted. ` +
        `Fix the relay, or set TRIAGE_MODEL=<spec> to try a different target.\n`,
    );
    process.exit(1);
  }

  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const e = queue[cursor++];
      let rec;
      try {
        const { status, body: r } = await post({
          model: MODEL,
          max_tokens: 4000,
          messages: [
            { role: 'system', content: SYS },
            { role: 'user', content: `Backlog entry (from docs/backlog/${e.file}):\n\n${e.text}` },
          ],
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        });
        // A provider/relay error body has no choices array. Surface ITS message —
        // it names the real cause (and often its own retry-after) — never the
        // information-free `finish_reason=undefined` it used to be reported as.
        // Deliberately NO retry/backoff here: pool failover is llm-relay's job,
        // and duplicating it in the caller would hide a relay defect.
        if (r?.error || !Array.isArray(r?.choices)) {
          const msg = r?.error?.message ?? JSON.stringify(r).slice(0, 400);
          throw new Error(`HTTP ${status} ${r?.error?.code ?? r?.error?.type ?? ''}: ${msg}`.trim());
        }
        const c = r.choices?.[0];
        if (c?.finish_reason !== 'stop') throw new Error(`finish_reason=${c?.finish_reason}`);
        // Some lanes prepend prose before the JSON despite the schema. Salvage the
        // object, but only from a response that finished cleanly (checked above), so
        // a truncated body can never be laundered into a valid-looking record.
        const raw = c.message.content ?? '';
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('no JSON object in response');
        rec = { id: e.id, file: e.file, ...JSON.parse(raw.slice(start, end + 1)) };
        rec.premise = premiseStamp(rec);
      } catch (err) {
        rec = { id: e.id, file: e.file, error: String(err.message || err) };
      }
      stamp.attempted += 1;
      if (rec.error) stamp.errored += 1;
      else stamp.classified += 1;
      // Rewritten per completion (cheap, atomic-enough for a progress sidecar):
      // a killed run leaves an honest partial stamp, not silence.
      stampSafe(stamp);
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
      process.stderr.write(`${e.id} -> ${rec.verdict ? `${rec.verdict} [premise: ${rec.premise}]` : 'ERR:' + rec.error}\n`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  stamp.finished_at = new Date().toISOString();
  stampSafe(stamp);
  process.stderr.write(
    `leg-2 coverage: ${stamp.classified} classified / ${stamp.errored} errored of ` +
      `${stamp.attempted} attempted (${stamp.prior_classified} prior, ${stamp.total_entries} total) — ${stampPath}\n`,
  );
}

// Import-safe: tests import the exported helpers without starting a sweep.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
