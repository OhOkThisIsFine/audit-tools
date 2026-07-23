#!/usr/bin/env node
//
// Render the nightly routine's open items as a single self-contained HTML file.
//
// WHY HTML AND NOT THE OLD MARKDOWN TABLES. The previous channel put a full
// paragraph of evidence inside one markdown table cell and printed it into the
// terminal at every session start. A 900-character cell is unreadable in a
// terminal, the block was large enough that the hook needed its own clip budget,
// and it arrived whether or not the owner was in a position to act. HTML fixes
// the render (real headings, collapsible evidence, per-item answer commands) and
// moves the channel off the conversation: the file is opened after the run and
// re-openable any time, so it is consulted deliberately instead of interrupting.
//
// Self-contained on purpose: inline CSS, no fonts, no scripts fetched. It opens
// from a file:// path with no network.
//
// Usage:
//   node scripts/nightly/render-digest.mjs [--root <repo>] [--open]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { readOpenItems, readDecisions, partitionBySettled, LEGS, LEG_TITLES, DIGEST_RELPATH } from './items.mjs';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const ROOT = rootFlag !== -1 ? args[rootFlag + 1] : process.env.CLAUDE_PROJECT_DIR || process.cwd();
const OPEN_AFTER = args.includes('--open');

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Minimal inline markdown: `code`, **bold**, and bare newlines. Deliberately not
// a markdown engine — item text is prose written by the routine, and an
// unescaped-HTML path through a full renderer is not worth the surface.
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

const STYLE = `
:root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1c1b19; --muted:#6b6a67; --line:#e3e1dd;
        --card:#fff; --accent:#7c5cff; --warn:#b4541a; --ok:#2f7d4f; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#181715; --fg:#eceae6; --muted:#9c9891; --line:#302e2b; --card:#211f1d;
          --accent:#a48bff; --warn:#e08a4e; --ok:#63b98a; }
}
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
       font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size:1.6rem; margin:0 0 .25rem; letter-spacing:-.01em; }
h2 { font-size:1.15rem; margin:2.5rem 0 .75rem; padding-bottom:.4rem; border-bottom:1px solid var(--line); }
.sub { color:var(--muted); margin:0 0 1.5rem; font-size:.9rem; }
.summary { display:flex; flex-wrap:wrap; gap:.5rem; margin:0 0 1.5rem; }
.pill { border:1px solid var(--line); border-radius:999px; padding:.2rem .7rem; font-size:.82rem;
        background:var(--card); color:var(--muted); }
.pill strong { color:var(--fg); }
.item { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--accent);
        border-radius:6px; padding:1rem 1.1rem; margin:0 0 .9rem; }
.item.stale { border-left-color:var(--warn); }
.item h3 { font-size:1rem; margin:0 0 .35rem; font-weight:600; }
.id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem; color:var(--accent);
      margin-right:.5rem; }
.meta { color:var(--muted); font-size:.8rem; margin:0 0 .6rem; }
.q { margin:.5rem 0; }
details { margin:.5rem 0 0; }
summary { cursor:pointer; color:var(--muted); font-size:.85rem; }
.evidence { margin:.5rem 0 0; padding-left:1.1rem; color:var(--muted); font-size:.9rem; }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85em;
       background:color-mix(in srgb, var(--fg) 8%, transparent); padding:.1em .35em; border-radius:3px; }
pre { background:color-mix(in srgb, var(--fg) 6%, transparent); border:1px solid var(--line);
      border-radius:5px; padding:.7rem .8rem; overflow-x:auto; font-size:.85rem; margin:.6rem 0 0; }
.answer { margin-top:.75rem; padding-top:.6rem; border-top:1px dashed var(--line); font-size:.85rem; }
.answer code { user-select:all; }
.empty { color:var(--muted); font-style:italic; }
.applied li { color:var(--muted); font-size:.9rem; }
footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--line);
         color:var(--muted); font-size:.82rem; }
`;

function renderItem(item) {
  const stale = Number(item.nights_open) >= 5;
  const evidence = Array.isArray(item.evidence) ? item.evidence.filter(Boolean) : [];
  const parts = [];
  parts.push(`<article class="item${stale ? ' stale' : ''}">`);
  parts.push(`<h3><span class="id">${esc(item.id)}</span>${inline(item.title)}</h3>`);

  const meta = [];
  if (item.path) meta.push(`<code>${esc(item.path)}</code>`);
  meta.push(
    Number(item.nights_open) > 1
      ? `open <strong>${esc(item.nights_open)} nights</strong> (since ${esc(item.first_seen)})`
      : 'new tonight',
  );
  parts.push(`<p class="meta">${meta.join(' &middot; ')}</p>`);

  if (item.question) parts.push(`<div class="q">${inline(item.question)}</div>`);
  if (item.proposal) parts.push(`<pre>${esc(item.proposal)}</pre>`);
  if (item.patch_path) {
    parts.push(`<p class="meta">Ready-to-apply patch: <code>${esc(item.patch_path)}</code></p>`);
  }
  if (evidence.length > 0) {
    parts.push('<details><summary>Evidence</summary><ul class="evidence">');
    for (const e of evidence) parts.push(`<li>${inline(e)}</li>`);
    parts.push('</ul></details>');
  }

  // The answer command is per-item and copy-ready. Recording an answer is what
  // makes the question stop coming back — including when the answer is "leave it
  // as it is", which the old channel had no way to represent at all.
  parts.push(
    `<div class="answer">Settle it: <code>node scripts/nightly/answer.mjs ${esc(item.id)} "your answer"</code></div>`,
  );
  parts.push('</article>');
  return parts.join('\n');
}

export function renderDigest({ generated_at, run, items, applied, skipped }) {
  const byLeg = new Map(LEGS.map((leg) => [leg, []]));
  for (const item of items) {
    if (!byLeg.has(item.leg)) byLeg.set(item.leg, []);
    byLeg.get(item.leg).push(item);
  }

  const stuck = items.filter((it) => Number(it.nights_open) >= 5);
  const when = generated_at ? new Date(generated_at) : new Date();
  const dateLabel = when.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  const head = [];
  head.push(`<h1>Nightly maintenance &mdash; ${esc(items.length)} open item${items.length === 1 ? '' : 's'}</h1>`);
  head.push(`<p class="sub">Run ${esc(dateLabel)}${run ? ` &middot; ${esc(run)}` : ''}</p>`);
  head.push('<div class="summary">');
  for (const leg of LEGS) {
    const n = (byLeg.get(leg) || []).length;
    head.push(`<span class="pill">${esc(LEG_TITLES[leg])}: <strong>${n}</strong></span>`);
  }
  head.push(`<span class="pill">auto-applied: <strong>${applied.length}</strong></span>`);
  if (stuck.length > 0) {
    head.push(`<span class="pill">open 5+ nights: <strong>${stuck.length}</strong></span>`);
  }
  head.push('</div>');

  if (stuck.length > 0) {
    // A question that keeps coming back is itself a finding: either it cannot be
    // answered as posed, or it should not have been asked. Name it rather than
    // letting repetition make it invisible.
    head.push(
      `<p class="sub"><strong>${stuck.length} item${stuck.length === 1 ? ' has' : 's have'} been open 5+ nights.</strong> ` +
        'If one is not answerable as posed, settle it with a note saying so &mdash; that is a valid answer and stops the re-ask.</p>',
    );
  }

  const body = [];
  for (const leg of LEGS) {
    const legItems = byLeg.get(leg) || [];
    body.push(`<h2>${esc(LEG_TITLES[leg])}</h2>`);
    if (legItems.length === 0) body.push('<p class="empty">Nothing open.</p>');
    else for (const item of legItems) body.push(renderItem(item));
  }

  if (applied.length > 0) {
    body.push('<h2>Applied automatically (FYI)</h2><ul class="applied">');
    for (const a of applied) body.push(`<li>${inline(typeof a === 'string' ? a : a.summary)}</li>`);
    body.push('</ul>');
  }
  if (skipped.length > 0) {
    // Never silent: a leg that could not run must say so, or a quiet digest
    // reads as "all clear" when it means "did not look".
    body.push('<h2>Not covered this run</h2><ul class="applied">');
    for (const s of skipped) body.push(`<li>${inline(typeof s === 'string' ? s : s.reason)}</li>`);
    body.push('</ul>');
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nightly maintenance &mdash; audit-tools</title>
<style>${STYLE}</style></head>
<body><main>
${head.join('\n')}
${body.join('\n')}
<footer>
Answer an item with <code>node scripts/nightly/answer.mjs &lt;ID&gt; "your answer"</code> &mdash; recorded in
<code>.claude/nightly-decisions.json</code> against the subject, so a settled question is never asked again
(a later edit to that prose legitimately re-opens it).<br>
Contract: <code>docs/nightly-routine.md</code>.
</footer>
</main></body></html>
`;
}

// Opening the digest is what replaces the every-conversation interrupt: the run
// puts it in front of the owner once, on its own schedule.
function openInBrowser(file) {
  const cmd =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', file]]
      : process.platform === 'darwin'
        ? ['open', [file]]
        : ['xdg-open', [file]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* opening is a convenience — never fail the run over it */
  }
}

// Entry point when run as a CLI (not when imported by the tests).
if (process.argv[1] && process.argv[1].endsWith('render-digest.mjs')) {
  const state = readOpenItems(ROOT);
  const decisions = readDecisions(ROOT);
  const { open, settled } = partitionBySettled(state.items, decisions);
  const html = renderDigest({ ...state, items: open });

  const out = join(ROOT, DIGEST_RELPATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, 'utf8');

  console.log(`nightly digest: ${open.length} open item(s) → ${DIGEST_RELPATH}`);
  if (settled.length > 0) {
    console.log(`  (${settled.length} suppressed: already settled in ${'.claude/nightly-decisions.json'})`);
  }
  if (OPEN_AFTER) openInBrowser(out);
}
