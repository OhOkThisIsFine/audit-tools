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
// mechanically, stamping
// `premise: holds|partial|premise_unconfirmed|probes_unusable|unprobed` on
// every record. Every invocation also RE-evaluates the stored records first —
// regenerating the triage is the presentation event for this lifecycle, so a
// record whose quoted fragment no longer matches reads as unconfirmed rather
// than surviving as a stale verdict.
//
// `gone` is deliberately ABSENT from that list (nightly sol-3, 2026-08-09). The
// model quotes fragments from the ENTRY, so "all probes absent" means its guess
// missed, never that the code went away — it was wrong 3 times out of 3. The
// strongest verdict belongs only to probe evaluation in the nightly writer,
// whose probes are authored to be checkable against the tree.
//
//   TRIAGE_MODEL=<spec>        explicit model id served by the router. DEFAULT
//                              IS DISCOVERED LIVE from the router's own
//                              /v1/models, preferring the `auto` alias — a
//                              hardcoded model name is a hand-held copy of the
//                              router's roster and went stale twice before.
//   TRIAGE_ENDPOINT=<url>      router origin, default http://127.0.0.1:3001
//   FREELLMAPI_API_KEY=<key>   router bearer key (dashboard -> Keys)
//   TRIAGE_CONCURRENCY=<n>     default 3
//
// HEALTH CONTRACT (P11, owner decision sol-4 2026-08-06). Three consecutive
// nights degraded silently to a partial sweep, each for a different transport
// fault. Now: (1) the model target is resolved live (above) and an unresolvable
// lane ABORTS at startup naming the escape; (2) one PREFLIGHT call runs before
// the sweep — a dead lane fails loudly at entry 0, not silently at entry 154
// (single attempt, matching the per-entry policy: failover is the router's job);
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
import {
  coverageStampPath,
  dispatchBoundedItems,
  LanePreflightError,
  writeAbortStamp,
} from './lane-dispatch.mjs';
import { evaluateProbes } from '../nightly/items.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Import-safe: tests import the exported helpers, so nothing below may exit or
// sweep unless this file IS the entrypoint. Single-sourced here and reused at
// the bottom — two copies of this test would drift.
const IS_CLI = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

// The one positional is an output PATH, so a flag in that slot is never one.
// Unguarded, `--help` BECAME the filename: the sweep started and wrote `--help`
// and `--help-coverage.json` into the repo root instead of printing usage — a
// wrong argument doing silent work rather than failing. Same shape of guard as
// scripts/check-gate-enumeration.mjs, which is where this was fixed once already.
const OUT_ARG = process.argv[2];
const USAGE = 'Usage: node scripts/shared/triage-backlog.mjs [outPath]';
if (IS_CLI && (OUT_ARG === '-h' || OUT_ARG === '--help')) {
  console.log(USAGE);
  console.log('  outPath                  default .audit-tools/backlog-triage.jsonl');
  console.log('  TRIAGE_MODEL=<spec>      model id; the default is discovered live');
  console.log('  TRIAGE_ENDPOINT=<url>    router origin, default http://127.0.0.1:3001');
  console.log('  FREELLMAPI_API_KEY=<key> router bearer key');
  console.log('  TRIAGE_CONCURRENCY=<n>   default 3');
  process.exit(0);
}
if (IS_CLI && OUT_ARG?.startsWith('-')) {
  console.error(`triage-backlog: unrecognized option "${OUT_ARG}" — the only positional is an output path.`);
  console.error(USAGE);
  process.exit(1);
}
// A flag never reaches here under direct invocation, and an importer's argv is
// none of this script's business — so the default stands for anything flag-shaped.
const OUT = OUT_ARG && !OUT_ARG.startsWith('-')
  ? OUT_ARG
  : join(ROOT, '.audit-tools', 'backlog-triage.jsonl');
const CONCURRENCY = Number(process.env.TRIAGE_CONCURRENCY || 3);

// The router is a local OpenAI-compatible gateway (FreeLLMAPI on :3001 by
// default). This lane has now outlived two transports — LiteLLM on :4000 and
// a previous local router — so nothing about it is hardcoded beyond the
// origin, which TRIAGE_ENDPOINT overrides.
const ENDPOINT = new URL(process.env.TRIAGE_ENDPOINT || 'http://127.0.0.1:3001');
const API_KEY = process.env.FREELLMAPI_API_KEY || '';

function defaultRosterSource() {
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      `fetch(${JSON.stringify(new URL('/v1/models', ENDPOINT).href)},{headers:${JSON.stringify({ authorization: `Bearer ${API_KEY}` })}})` +
        `.then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e.message);process.exit(1)})`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  if (r.error || r.status !== 0) {
    throw new Error(r.error?.message || (r.stderr || '').trim() || `roster probe exited ${r.status}`);
  }
  return r.stdout;
}

/**
 * Resolve the model spec: an explicit TRIAGE_MODEL wins verbatim; otherwise the
 * router's live roster is asked for. Never a hardcoded model id — the router
 * owns its roster and changes it without telling this script.
 */
export function resolveTriageModel(env = process.env, rosterSource = defaultRosterSource) {
  const explicit = env.TRIAGE_MODEL;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  let raw;
  try {
    raw = rosterSource();
  } catch (err) {
    throw new Error(
      `triage lane cannot resolve a model target: router roster discovery failed ` +
        `(${/** @type {any} */ (err)?.message ?? err}). The lane is DEAD, not slow — start the router or set ` +
        `TRIAGE_MODEL=<spec> to bypass discovery.`,
    );
  }
  let roster;
  try {
    roster = JSON.parse(raw);
  } catch {
    throw new Error(
      `triage lane cannot resolve a model target: router returned an unparseable roster ` +
        `(${String(raw).slice(0, 120)}). Set TRIAGE_MODEL=<spec> to bypass discovery.`,
    );
  }
  const ids = (Array.isArray(roster?.data) ? roster.data : [])
    .map((m) => (typeof m?.id === 'string' ? m.id : null))
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error(
      'triage lane cannot resolve a model target: router reports no available models. ' +
        'Set TRIAGE_MODEL=<spec> to bypass discovery.',
    );
  }
  // Mechanical classification wants a fast target (the header notes measure a
  // heavy reasoner at ~4min/entry vs seconds). `auto` delegates that choice to
  // the router, which is the only thing that knows live health and quota.
  return ids.includes('auto') ? 'auto' : ids[0];
}

/** Tracked files matching a git query, or null when git cannot answer. */
function trackedMatches(root, args, okStatuses = [0]) {
  const out = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (out.error || !okStatuses.includes(/** @type {number} */ (out.status))) return null;
  return out.stdout.split('\n').filter((l) => l.trim() !== '');
}

/**
 * Repair the two INPUT defects that made a third of the sweep's probes
 * unusable — without inventing evidence.
 *
 * The model authoring these probes cannot see the repo, so it names the path
 * the ENTRY mentions. That is often a bare basename, and sometimes only a
 * symbol. Both are recoverable against the tracked tree, and recovering them is
 * strictly better than stamping the record unusable.
 *
 * The bound that matters: a repair applies ONLY when exactly one tracked file
 * matches. Zero or several leaves the probe untouched, because guessing a path
 * would manufacture precisely the false verdict this change exists to stop. A
 * repair is RECORDED (`recovered[]`) rather than silently substituted, so a
 * reader can see the sweep chose the path rather than the entry naming it.
 */
function resolveProbes(raw, root) {
  const probes = [];
  const recovered = [];
  for (const p of raw) {
    if (!p || typeof p.contains !== 'string') continue;
    const named = typeof p.file === 'string' ? p.file.replace(/\\/g, '/').replace(/^\.\//, '') : '';
    // A path the entry gave in full is used as-is — including a record path,
    // which the evaluator abstains on by design.
    if (named.includes('/')) {
      probes.push({ file: named, contains: p.contains });
      continue;
    }
    // Bare basename, or no path at all but a symbol to search for.
    let hits = null;
    let how = null;
    if (named !== '') {
      hits = trackedMatches(root, ['ls-files', '--', `*/${named}`, named]);
      how = 'basename';
    } else if (typeof p.symbol === 'string' && p.symbol.trim() !== '') {
      hits = trackedMatches(
        root,
        ['grep', '-l', '-F', '-e', p.symbol, '--',
          ':!docs/backlog', ':!docs/reviews', ':!docs/HANDOFF.md', ':!docs/nightly-inbox.md', ':!.claude'],
        [0, 1],
      );
      how = 'symbol';
    }
    if (hits && hits.length === 1) {
      probes.push({ file: hits[0], contains: p.contains });
      recovered.push({ from: named || p.symbol, via: how, to: hits[0] });
      continue;
    }
    // Ambiguous or unresolvable: keep whatever was given so the evaluator
    // reports it as signal-free rather than the sweep quietly dropping it.
    if (named !== '') probes.push({ file: named, contains: p.contains });
  }
  return { probes, recovered };
}

/**
 * Map the shared evaluator's item-level view onto a per-record stamp.
 *
 * `partial` is surfaced separately from `holds` because a half-vanished premise
 * is exactly the "verify against HEAD before working it" case.
 *
 * Two verdicts this sweep must NOT emit, both from nightly sol-3 (2026-08-09):
 *
 *  - `gone` is retired outright. The sweep asks the model to quote a fragment
 *    VERBATIM FROM THE ENTRY, so "all probes absent" means the entry's own prose
 *    is not in the file the model guessed — never that the code went away. It
 *    was wrong every single time it fired (3 false, 0 true across two nights),
 *    and it is the strongest claim the pipeline can make. Only probe evaluation
 *    in the nightly writer, which reads the tree against probes authored to be
 *    checkable, may assert goneness. Here it stamps `premise_unconfirmed`.
 *
 *  - `unprobed` no longer absorbs a record that TRIED and failed. A row whose
 *    probes were all unusable now stamps `probes_unusable`, visibly distinct
 *    from one that honestly quoted nothing checkable, counted in the coverage
 *    stamp, and never evidence for deleting an entry when paired with
 *    `already_shipped_or_stale`.
 */
export function premiseVerdict(rec, root = ROOT) {
  const raw = Array.isArray(rec?.premise_probes) ? rec.premise_probes : [];
  const { probes: resolved, recovered } = resolveProbes(raw, root);
  const { status, probes } = evaluateProbes(root, { premise_probes: resolved });
  const stamp = (() => {
    if (status === 'unprobed') return raw.length > 0 ? 'probes_unusable' : 'unprobed';
    if (status === 'resolved') return 'premise_unconfirmed';
    const signalFree = new Set(['bad_path', 'unknown', 'error', 'untrackable']);
    if (probes.every((p) => signalFree.has(p.state))) return 'probes_unusable';
    return probes.some((p) => p.state === 'absent') ? 'partial' : 'holds';
  })();
  return { stamp, recovered };
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
          // `file` is no longer required: the author cannot see the repo, and
          // forcing a path made it emit bare basenames and guesses. Naming a
          // `symbol` instead is honest, and the sweep resolves it against the
          // tracked tree when exactly one file matches.
          required: ['contains'],
          properties: {
            file: {
              type: 'string',
              description:
                'repo-relative path the entry names; a bare filename is accepted and resolved when unambiguous',
            },
            symbol: {
              type: 'string',
              description:
                'an identifier to locate the file by, when the entry names no path — use INSTEAD of file, never a guess',
            },
            contains: { type: 'string', description: 'a literal fragment the entry quotes from that file' },
          },
        },
      },
    },
  },
};

// Single-sourced from the schema so the validation below can never disagree
// with what the lane was asked to produce.
export const TRIAGE_VERDICTS = new Set(SCHEMA.schema.properties.verdict.enum);

// P20 (owner decision sol-2, 2026-08-12): parsing is not classifying. A
// response that parses as JSON but is not a triage record — the schema
// envelope echoed back, a bare probe fragment — used to count as classified:
// the fourth route in four dates by which the sweep reported coverage it did
// not achieve. Every prior fix hardened the transport; this validates the
// payload. The check asserts only what the stamp reader consumes (verdict in
// the schema's enum, non-empty why/action), so a schema extension does not
// become a false red. A mismatch throws, landing in the worker's existing
// errored/resume path — no new lifecycle.
export function buildTriageRecord(entry, raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in response');
  // Spread first, identity last: id/file are the sweep's facts about which
  // entry this is — never the model's to state. (With the spread last, one
  // record acquired a TypeScript source path as its `file` and lost the
  // ability to say which entry it was about.)
  const rec = { ...JSON.parse(raw.slice(start, end + 1)), id: entry.id, file: entry.file };
  const bad = [];
  if (!TRIAGE_VERDICTS.has(rec.verdict)) bad.push(`verdict=${JSON.stringify(rec.verdict ?? null)}`);
  if (typeof rec.why !== 'string' || rec.why.trim() === '') bad.push('why');
  if (typeof rec.action !== 'string' || rec.action.trim() === '') bad.push('action');
  if (bad.length > 0) {
    throw new Error(`response did not match the triage schema (${bad.join(', ')})`);
  }
  return rec;
}

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
disappearance would mean the entry is done. Emit [] only when the entry quotes nothing checkable.

Three rules about the TARGET, each of which made a third of the previous run's probes worthless:
- A probe aimed at docs/backlog, docs/reviews, docs/HANDOFF.md, docs/nightly-inbox.md or .claude
  carries NO evidence. Those files are the RECORD of the code, not the code — a backlog entry quotes
  the very fragment it is about, so finding it there proves nothing and losing it means nothing.
  Probe the source file the entry is ABOUT, never the entry itself.
- If the entry names no path, emit { symbol, contains } instead of guessing a path. An identifier is
  resolvable against the tree; a guessed path is not, and a wrong one is worse than none.
- A bare filename is fine when that is all the entry gives — do not invent directories for it.`;

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: ENDPOINT.hostname, port: ENDPOINT.port || 80, path: '/v1/chat/completions', method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
        } },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 400)}`)); }
        });
      },
    );
    req.setTimeout(20 * 60 * 1000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// A provider/router error body has no choices array. Surface ITS message — it
// names the real cause (and often its own retry-after) — never the
// information-free `finish_reason=undefined` it used to be reported as.
// Deliberately NO retry/backoff anywhere in this lane: failover is the
// router's job, and duplicating it in the caller would hide a router defect.
function chatFailure(status, r) {
  const msg = r?.error?.message ?? JSON.stringify(r).slice(0, 400);
  return new Error(`HTTP ${status} ${r?.error?.code ?? r?.error?.type ?? ''}: ${msg}`.trim());
}

// The sweep itself — resume, worker pool, coverage stamp — is the shared
// one-item-per-call driver (scripts/shared/lane-dispatch.mjs). This file owns
// only the triage DOMAIN: backlog chunking, the schema, premise probing, and
// the HTTP router lane.
async function main() {
  let MODEL;
  const stampPath = coverageStampPath(OUT);
  try {
    MODEL = resolveTriageModel();
  } catch (err) {
    writeAbortStamp(stampPath, {
      aborted: String(/** @type {any} */ (err).message || err),
      totalEntries: entries.length,
    });
    process.stderr.write(`${/** @type {any} */ (err).message}\n`);
    process.exit(1);
  }

  let stamp;
  try {
    ({ stamp } = await dispatchBoundedItems({
      items: entries,
      outPath: OUT,
      concurrency: CONCURRENCY,
      stampSeed: { model: MODEL },
      // Counted so "the sweep covered 121 entries" cannot hide how many of
      // those carried probes that could not be evaluated at all. 30 of 121 did
      // on 2026-08-09, indistinguishable from an honest `unprobed` until now.
      stampInit: { probes_unusable: 0 },
      stampExtra: (s, rec) => {
        if (rec.premise === 'probes_unusable') s.probes_unusable += 1;
      },
      // Re-evaluate the premise of every stored record on load: running this
      // script IS the presentation event for triage verdicts, so a record
      // whose quoted code vanished since the last run must read as
      // unconfirmed now, not carry last week's stamp.
      reviveRecord: (rec) => {
        const { stamp: premise, recovered } = premiseVerdict(rec);
        return {
          ...rec,
          premise,
          ...(recovered.length > 0 ? { premise_probes_recovered: recovered } : {}),
        };
      },
      preflight: async () => {
        const { status, body: r } = await post({
          model: MODEL,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        });
        if (r?.error || !Array.isArray(r?.choices)) throw chatFailure(status, r);
      },
      callLane: async (e) => {
        const { status, body: r } = await post({
          model: MODEL,
          max_tokens: 4000,
          messages: [
            { role: 'system', content: SYS },
            { role: 'user', content: `Backlog entry (from docs/backlog/${e.file}):\n\n${e.text}` },
          ],
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        });
        if (r?.error || !Array.isArray(r?.choices)) throw chatFailure(status, r);
        const c = r.choices?.[0];
        // The content is returned even on a non-stop finish: the driver
        // records its byte size, which is the truncation diagnostic (P28 —
        // near-zero = dialect death, large-but-truncated = a cap to raise).
        return { raw: c?.message?.content ?? '', finishReason: c?.finish_reason };
      },
      buildRecord: (e, { raw, finishReason }) => {
        // `finish_reason !== 'stop'` is OpenAI-chat policy, so it lives HERE,
        // never in the lane-agnostic driver — but AFTER the lane returned, so
        // the error row still carries finish_reason/output_bytes.
        if (finishReason !== 'stop') throw new Error(`finish_reason=${finishReason}`);
        // Some lanes prepend prose before the JSON despite the schema. Salvage +
        // parse + shape-validate live in buildTriageRecord — only a response that
        // finished cleanly (checked above) reaches it, so a truncated body can
        // never be laundered into a valid-looking record.
        const rec = buildTriageRecord(e, raw);
        const { stamp: premise, recovered } = premiseVerdict(rec);
        rec.premise = premise;
        if (recovered.length > 0) rec.premise_probes_recovered = recovered;
        return rec;
      },
      onProgress: (e, rec) => {
        process.stderr.write(`${e.id} -> ${rec.verdict ? `${rec.verdict} [premise: ${rec.premise}]` : 'ERR:' + rec.error}\n`);
      },
    }));
  } catch (err) {
    if (err instanceof LanePreflightError) {
      process.stderr.write(
        `${err.message}\nThe lane is DEAD, not slow — nothing was attempted. ` +
          `Fix the router, or set TRIAGE_MODEL=<spec> to try a different target.\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  process.stderr.write(
    `leg-2 coverage: ${stamp.classified_total} classified total (${stamp.classified} this pass) / ` +
      `${stamp.errored} errored / ${stamp.probes_unusable} probes-unusable of ` +
      `${stamp.attempted} attempted (${stamp.prior_classified} prior, ${stamp.total_entries} total) — ${stampPath}\n`,
  );
}

if (IS_CLI) {
  await main();
}
