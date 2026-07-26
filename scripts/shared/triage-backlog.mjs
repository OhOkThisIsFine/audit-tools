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
// run continues rather than restarting. Errored rows are NOT skipped — delete
// them from the file and re-run to retry, optionally on a stronger alias.
//
//   TRIAGE_MODEL=<alias>       default gpt-oss-120b; glm-5.2 for retries
//   TRIAGE_CONCURRENCY=<n>     default 3
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
import fs from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CLAUDE_PROJECT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] || join(ROOT, '.audit-tools', 'backlog-triage.jsonl');
const MODEL = process.env.TRIAGE_MODEL || 'gpt-oss-120b';
const CONCURRENCY = Number(process.env.TRIAGE_CONCURRENCY || 3);

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
  return entries.map((e, i) => ({
    id: `${file.replace('.md', '')}#${i + 1}`,
    file,
    text: e.body.join('\n').trim(),
  }));
}

const entries = [...chunk('open-bugs.md'), ...chunk('forward-tracks.md'), ...chunk('deferred.md')];

const SCHEMA = {
  name: 'backlog_triage',
  strict: false,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'verdict', 'why', 'action', 'effort', 'code_paths'],
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

Be strict. Prefer actionable_now when a property to hold is stated and the fix site is named.`;

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: 4000, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(buf.slice(0, 400))); } });
      },
    );
    req.setTimeout(20 * 60 * 1000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const done = new Set();
if (fs.existsSync(OUT)) {
  for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { done.add(JSON.parse(l).id); } catch {}
  }
}

const queue = entries.filter((e) => !done.has(e.id));
let cursor = 0;

async function worker() {
  while (cursor < queue.length) {
  const e = queue[cursor++];
  let rec;
  try {
    const r = await post({
      model: MODEL,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: `Backlog entry (from docs/backlog/${e.file}):\n\n${e.text}` },
      ],
      response_format: { type: 'json_schema', json_schema: SCHEMA },
    });
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
  } catch (err) {
    rec = { id: e.id, file: e.file, error: String(err.message || err) };
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  process.stderr.write(`${e.id} -> ${rec.verdict || 'ERR:' + rec.error}\n`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.error('DONE');
