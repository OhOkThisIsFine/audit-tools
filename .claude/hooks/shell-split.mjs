// Quote-aware shell statement utilities, single-sourced for the PreToolUse
// hooks (shell-trap-guard.mjs, pre-commit-gate.mjs). Plain node — no deps.
//
// A quote-BLIND split on `&&`/`||`/`;`/newline breaks statements apart at
// separators INSIDE quoted strings — e.g. a `codex exec "long prompt; with
// semicolons" < /dev/null` splits mid-prompt, detaching the stdin redirect
// from the codex statement and false-blocking a correct command (observed
// live 2026-07-23). Rules that reason about one statement's flags must see
// the whole statement.

// Blank out single/double-quoted span CONTENT (the quote characters remain,
// and length is preserved) so shell-syntax reasoning is not fooled by quoted
// text. Naive about backslash-escaped quotes on purpose — the payloads are
// tool commands, not adversarial input, and FAIL-OPEN callers tolerate a
// mis-strip.
export function stripQuoted(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      out += c === quote ? c : ' ';
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else {
      out += c;
    }
  }
  return out;
}

// Blank out HEREDOC BODIES (`<<EOF` / `<<-'EOF'` … terminator line), preserving
// line structure. A heredoc body is DATA on stdin — it never becomes argv, so a
// tool name or flag inside one cannot execute. Without this, writing a commit
// message that merely NAMES a trap (`git commit -F -` with a body describing
// `mktemp`, say) is refused as if it were the trap — which is how this function
// came to exist.
//
// Deliberately NOT the same policy as the commit gate's bypass-token scan: a
// genuinely quoted `"--no-verify"` still reaches git, so that scan reads the
// whole command on purpose. A heredoc body reaches nothing.
export function stripHeredocBodies(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  let terminator = null;
  for (const line of lines) {
    if (terminator !== null) {
      out.push(line.trim() === terminator ? line : '');
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    out.push(line);
    // Matched on the RAW line: stripQuoted blanks quoted CONTENT, which eats the
    // delimiter in the `<<'EOF'` form (the most common one) and leaves nothing to
    // match. Over-matching here only blanks more text, i.e. yields fewer denials —
    // the safe direction for a guard.
    const m = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (m) terminator = m[2];
  }
  return out.join('\n');
}

// Split a command into shell statements on `&&`, `||`, `;`, and newlines that
// occur OUTSIDE quoted spans. stripQuoted is length-preserving, so separator
// positions found on the stripped text index directly into the raw text —
// each returned statement keeps its original quoted content intact.
export function splitShellStatements(cmd) {
  const stripped = stripQuoted(cmd);
  const parts = [];
  let start = 0;
  const sep = /&&|\|\||;|\n/g;
  let m;
  while ((m = sep.exec(stripped)) !== null) {
    parts.push(cmd.slice(start, m.index));
    start = m.index + m[0].length;
  }
  parts.push(cmd.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
}
