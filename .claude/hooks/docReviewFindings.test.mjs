#!/usr/bin/env node
// Unit tests for the shared doc-review findings reader.
// Tests: OPEN-block extraction (present / absent / headers-only), item parse
//        (section tracking, summary strip, truncation), and collectOpenItems with
//        an injected git (ref discovery + no-fetch + parse), incl. offline → null.
//
// Run: node .claude/hooks/docReviewFindings.test.mjs
import assert from 'node:assert/strict';
import {
  extractOpenText,
  parseOpenItems,
  collectOpenItems,
  SUMMARY_MAX,
  FILE,
  BRANCH,
} from './docReviewFindings.mjs';

let passed = 0;
let failed = 0;
function test(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${label}\n        ${e.message}`);
    failed++;
  }
}

const START = '<!-- DOC-REVIEW-OPEN:START -->';
const END = '<!-- DOC-REVIEW-OPEN:END -->';
const wrap = (inner) => `# findings\n\nsome preamble\n${START}\n${inner}\n${END}\ntrailer\n`;

test('extractOpenText pulls the block, empty when absent/headers-only', () => {
  assert.equal(extractOpenText(wrap('- [D-1] a thing')), '- [D-1] a thing');
  assert.equal(extractOpenText('no markers here'), '');
  assert.equal(extractOpenText(wrap('   ')), ''); // empty block
  assert.equal(extractOpenText(wrap('## a header\nprose but no items')), ''); // no list items
  assert.equal(extractOpenText(''), '');
});

test('parseOpenItems tracks sections + strips the id token', () => {
  const items = parseOpenItems(
    '- [AF-1] first, no header yet\n' +
      '## Instruction edits\n' +
      '- [D-5]   spaced   summary  \n' +
      'a continuation line (dropped)\n' +
      '* [D-6] bullet-star form',
  );
  assert.deepEqual(items, [
    { section: 'Open items', id: 'AF-1', summary: 'first, no header yet' },
    { section: 'Instruction edits', id: 'D-5', summary: 'spaced summary' },
    { section: 'Instruction edits', id: 'D-6', summary: 'bullet-star form' },
  ]);
});

test('parseOpenItems truncates an over-long summary', () => {
  const long = 'x'.repeat(SUMMARY_MAX + 50);
  const [it] = parseOpenItems(`- [D-9] ${long}`);
  assert.equal(it.summary.length, SUMMARY_MAX);
  assert.ok(it.summary.endsWith('…'));
});

// A fake git bound to a canned findings body on the audit-tools remote ref.
function fakeGit(body, { sha = 'deadbeefcafe0000', remote = 'audit-tools' } = {}) {
  const wantRef = `refs/remotes/${remote}/${BRANCH}`;
  return (args) => {
    if (args[0] === 'remote') return `${remote}\n`;
    if (args[0] === 'show') {
      if (args[1] === `${wantRef}:${FILE}`) return body;
      throw new Error('no such ref');
    }
    if (args[0] === 'rev-parse') {
      if (args[1] === wantRef) return `${sha}\n`;
      throw new Error('no such ref');
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

test('collectOpenItems discovers the ref, parses, and does NOT fetch', () => {
  let fetched = false;
  const base = fakeGit(wrap('- [D-1] alpha\n- [D-2] beta'));
  const git = (args, t) => {
    if (args[0] === 'fetch') { fetched = true; throw new Error('should not fetch'); }
    return base(args, t);
  };
  const got = collectOpenItems(git);
  assert.equal(fetched, false); // resolve path must stay fast/offline-tolerant
  assert.equal(got.sha, 'deadbeefcafe0000');
  assert.equal(got.usedRef, 'refs/remotes/audit-tools/doc-review');
  assert.deepEqual(got.items.map((i) => i.id), ['D-1', 'D-2']);
});

test('collectOpenItems → null when no findings ref is available (offline)', () => {
  const git = (args) => {
    if (args[0] === 'remote') return 'audit-tools\n';
    throw new Error('offline'); // show/rev-parse all fail
  };
  assert.equal(collectOpenItems(git), null);
});

test('collectOpenItems → empty items for an empty OPEN block', () => {
  const got = collectOpenItems(fakeGit(wrap('   ')));
  assert.deepEqual(got.items, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
