# Patch 1/3 — `.claude/hooks/shell-split.mjs`

Append after `findLiveBackticks()` (which ends at line 136 at the time of writing). The walk
is the same three-way quote-context scan; only the character it looks for differs, so the
comment says why they are siblings rather than one being copied from the other.

```js
// Find EXPANSIONS of the named variables, in positions where the shell actually
// expands them. Sibling of findLiveBackticks above — same three-way quote-context
// walk, different trigger — because the property is the same one: what the WRITER
// reads as text, the shell reads as syntax.
//
// Expanding: bare (outside quotes) and inside DOUBLE quotes. Inert: inside SINGLE
// quotes, and backslash-escaped in either expanding position. Matches both `$NAME`
// and `${NAME}`. Returns `[{ index, name, context: 'double' | 'bare' }]`, empty
// when every occurrence is inert.
//
// This exists because stripQuoted() cannot answer the question: it blanks
// double-quoted spans, and `> "$TMPDIR/x"` — a double-quoted expansion — is the
// exact form the trap takes every time it is hit.
export function findLiveExpansions(s, names) {
  const hits = [];
  if (!Array.isArray(names) || names.length === 0) return hits;
  const wanted = new Set(names);
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue; // no escapes inside single quotes; nothing expands
    }
    if (c === '\\' && i + 1 < s.length) {
      i++; // escaped char — literal in both remaining positions
      continue;
    }
    if (c === '$') {
      const rest = s.slice(i + 1);
      const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}|^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
      const name = m?.[1] ?? m?.[2];
      if (name && wanted.has(name)) {
        hits.push({ index: i, name, context: quote === '"' ? 'double' : 'bare' });
      }
      if (m) i += m[0].length;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
  }
  return hits;
}
```
