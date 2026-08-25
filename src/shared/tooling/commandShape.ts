import { scanStringAware } from "../parsing/stringAwareScanner.js";

/**
 * THE declared single-invocation command shape — one rule, every boundary.
 *
 * A declared command (a block's `targeted_commands`) is a string an operator
 * wrote and this tool then RUNS. The rule exists because such a string must
 * denote exactly ONE invocation: anything that chains, redirects, substitutes
 * or subshells turns one declared test into arbitrary execution. A flat regex
 * cannot decide this: `node -e "process.exit(0)"` is an ordinary test
 * invocation whose parens are inside quotes, and refusing it would refuse the
 * normal case.
 *
 * WHAT THE RULE IS *NOT*: an escaping scheme for one particular spawn. The
 * consumers no longer agree on how they spawn — the closing suites and the
 * required-test rerun split the string with {@link parseCommandString} and
 * spawn `shell: false`, while the triage re-verification path still hands it to
 * a shell — and the rule is identical for all of them. That is the point of
 * stating it once here: the property enforced belongs to the DECLARATION, not
 * to the spawner. A string carrying `&&` or a redirect declares work this
 * contract cannot faithfully run as ONE invocation, and must be refused up
 * front — whether the consumer would have let a shell act on it or would have
 * silently reduced it to literal argv bytes. Enforcing the same rule at every
 * boundary is also what keeps producer and consumer agreeing about which
 * declarations are admissible at all.
 *
 * So the scan is QUOTE-AWARE — a tiny, fully-owned grammar, not a shell parser.
 * It is deliberately narrower than EITHER shell's grammar, because a declared
 * command historically reached `shell: true` — TWO grammars, and no per-grammar
 * state machine is sound for both: `/bin/sh -c` on posix, `cmd.exe /d /s /c` on
 * win32. Where they disagree, tracking state under one of them MIS-CLASSIFIES
 * the other, and keeping the union-of-both-grammars refusal is what lets the
 * same admission decision hold on every platform:
 *
 *   - `'` quotes on sh and is an ORDINARY CHARACTER on cmd.exe, so crediting it
 *     reads `echo '& evil.exe'` as fully quoted while cmd.exe reads `&` as a
 *     command separator and starts a second process.
 *   - `\` escapes a quote on sh, so `echo \" & evil \"` de-syncs any
 *     double-quote tracking: the scan believes `&` is quoted, sh sees an escaped
 *     literal quote and a live separator.
 *   - `%VAR%` is expanded by cmd.exe BEFORE the line is split into commands, and
 *     expands inside double quotes too, so a `%…%` reference can introduce
 *     separators that were never in the scanned string.
 *   - `^` is cmd.exe's escape character and de-syncs quote state the same way.
 *   - CR and LF are not inert inside cmd.exe's double quotes: LF truncates the
 *     command there and CR is deleted outright, so what runs is not what was
 *     scanned. Every control character is refused for that reason.
 *
 * What remains is the one construct both shells agree on: a double quote makes
 * the enclosed metacharacters literal. So `' \ ^ % $` and backtick — plus every
 * control character — are refused in EVERY position, quoted or not; the
 * chaining/redirection/grouping set is refused outside double quotes; and an
 * unterminated double quote is itself a refusal, because the rest of the string
 * cannot be classified.
 *
 * The fail direction is REFUSAL. Over-refusing a legitimate command costs a
 * producer-side split; under-admitting one hands a shell an extra process.
 *
 * WHY IT LIVES HERE. The shape used to be enforced by THREE disagreeing
 * implementations — this quote-aware walk at the host-handoff consumer, a
 * quote-BLIND `/[&|;<>`$\n\r\0]/` at the contract-pipeline producer, and NOTHING
 * at all on the triage re-verification path that also spawns these strings. The
 * two that existed disagreed in BOTH directions: `pytest -k 'not slow'` cleared
 * promotion and then dead-ended at the consumer as `block_contract_invalid`,
 * while `echo "a & b"` was refused at promotion though the consumer admits it.
 * A rule enforced in three places is a rule that holds in none of them, so it is
 * single-sourced here and every boundary asks THIS module.
 */

/**
 * Characters refused in EVERY position, quoted or not: the control characters
 * (`< 0x20` and DEL) plus the per-shell escape/expansion set `' \ ^ % $` and
 * backtick. Matched raw, BEFORE any quote-state walk — quote state cannot be
 * trusted to classify the very characters that de-sync it.
 */
const UNCONDITIONALLY_REFUSED = /[\u0000-\u001f\u007f'\\^%$`]/;

/** Chaining, redirection and grouping — refused only OUTSIDE double quotes. */
const REFUSED_WHEN_UNQUOTED = "&|;<>()";

/**
 * Does `command` leave the declared single-invocation shape?
 *
 * `true` ⇒ REFUSE. This is the whole rule; callers add only how a refusal is
 * reported (a thrown `BlockContractError`, a refusal line, a non-spawn).
 */
export function commandLeavesDeclaredShape(command: string): boolean {
  if (UNCONDITIONALLY_REFUSED.test(command)) return true;

  // Quote toggling matches the raw walk exactly: `escapedQuotes: []` because a
  // backslash is refused outright above, so nothing may escape a quote here and
  // EVERY `"` flips the state. Only genuinely unquoted characters reach
  // `onUnquoted`, which is exactly the set the quoted case is allowed to hide.
  let open = false;
  let refused = false;
  scanStringAware(
    command,
    { quoteChars: ['"'], escapedQuotes: [] },
    {
      onQuoteOpen: () => {
        open = true;
      },
      onQuoteClose: () => {
        open = false;
      },
      onUnquoted: (char) => {
        if (!REFUSED_WHEN_UNQUOTED.includes(char)) return;
        refused = true;
        return false;
      },
    },
  );
  // An unterminated quote is itself a refusal: the rest of the string cannot be
  // classified, so it cannot be admitted.
  return refused || open;
}

/**
 * Partition declared commands into the admitted ones and refusal LINES —
 * refusals as data, never a throw, for producers that must turn a malformed
 * command into a bounded re-emit rather than an unclassified stack.
 *
 * Entries are trimmed; an entry that is absent, non-string or blank is refused
 * as `"empty"`. `describeRefusal` owns the wording (which artifact field, which
 * block), so this module stays the RULE and never the vocabulary.
 */
export function partitionCommandsByDeclaredShape(
  commands: readonly string[],
  describeRefusal: (kind: "empty" | "leaves-shape", raw: unknown) => string,
): { commands: string[]; refusals: string[] } {
  const admitted: string[] = [];
  const refusals: string[] = [];
  for (const raw of commands) {
    const command = typeof raw === "string" ? raw.trim() : "";
    if (command.length === 0) {
      refusals.push(describeRefusal("empty", raw));
      continue;
    }
    if (commandLeavesDeclaredShape(command)) {
      refusals.push(describeRefusal("leaves-shape", raw));
      continue;
    }
    admitted.push(command);
  }
  return { commands: admitted, refusals };
}

/**
 * Split a command string into an argv array, so it can be spawned with
 * `shell: false`.
 *
 * TOTAL, and its guarantee is stated in terms of `shell: false` — not in terms
 * of a precondition a caller has to remember. Exactly two characters are
 * special: an unquoted space ENDS a token, and a double quote toggles grouping
 * and is dropped. EVERY other byte — including `' \ ^ % $` and backtick, and
 * including `& | ; < > ( )` — is copied into the token literally, which under
 * `shell: false` is precisely what the child receives, because no shell ever
 * parses the result. So for any input this produces the argv that a shell-free
 * spawn will actually deliver; it never silently drops meaning.
 *
 * What it does NOT do is decide whether a command was ADMISSIBLE. A string that
 * fails {@link commandLeavesDeclaredShape} still splits — `a && b` becomes
 * `["a", "&&", "b"]`, three literal argv tokens — and that argv is a faithful
 * rendering of what `shell: false` would run, not an execution of the chain the
 * author wrote. That is a declaration the contract cannot honour, so it must be
 * REFUSED by the gate before it reaches a spawn; this function is not the place
 * that decision is made, and it is not a shell parser standing in for one.
 *
 * Windows note: because `\` is an ordinary byte here, an absolute Windows path
 * survives intact through the split (`C:\Program Files\nodejs\node.exe` stays
 * one token when double-quoted). The declared-shape gate refuses `\` in every
 * position, so such a path can only reach this function from a caller that did
 * not gate — see {@link commandLeavesDeclaredShape}'s header for why the
 * refusal is about the declaration rather than the spawn.
 */
export function parseCommandString(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of command) {
    if (char === '"') {
      // A quote both toggles the state and MARKS the token as started, so an
      // explicit empty argument (`""`) survives as an empty string rather than
      // vanishing at the length check below.
      quoted = !quoted;
      started = true;
      continue;
    }
    if (char === " " && !quoted) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}
