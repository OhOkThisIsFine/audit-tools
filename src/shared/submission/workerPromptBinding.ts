// sites-pinned: tests/remediate/host-handoff.test.ts, tests/audit/host-handoff.test.ts
// (both draws bind their worker prompts here, so a change to where the digest
// stops moves every `prompt_sha256` the tests re-derive from the prompt text)
/**
 * THE worker-prompt binding both draws share (owner review of prompt 20,
 * 2026-09-18).
 *
 * A worker prompt ENDS with the result the tool expects, as a JSON template
 * whose identity values — run id, work item id, result id, prompt digest — the
 * tool fills in. The worker copies them; it never derives, chooses or looks
 * them up. A text cannot carry its own digest, so the digest covers the BODY:
 * the text above the template. The template is then a pure function of the
 * digest, so the whole text is still re-derivable from the digest and the
 * body, and a parse can check both halves.
 */
import { promptSha256 } from "./hostHandoffCore.js";

/** A worker prompt as both draws persist it on a work item. */
interface BoundWorkerPrompt {
  readonly text: string;
  readonly sha256: string;
}

/** The separator between the body and the template. */
const BODY_TAIL_SEPARATOR = "\n\n";

/**
 * Bind a prompt body to its result template. `renderTail` receives the body
 * digest and returns the template text — the caller derives the result id from
 * the same digest with `deriveResultId`.
 */
export function bindWorkerPrompt(
  body: string,
  renderTail: (promptDigest: string) => string,
): BoundWorkerPrompt {
  const digest = promptSha256(body);
  return { text: `${body}${BODY_TAIL_SEPARATOR}${renderTail(digest)}`, sha256: digest };
}

/**
 * Does a persisted prompt hold its binding: the text ends with the template the
 * digest renders, and the digest is the digest of the text above it?
 */
export function workerPromptBindingHolds(
  prompt: BoundWorkerPrompt,
  renderTail: (promptDigest: string) => string,
): boolean {
  const tail = `${BODY_TAIL_SEPARATOR}${renderTail(prompt.sha256)}`;
  if (!prompt.text.endsWith(tail)) return false;
  return promptSha256(prompt.text.slice(0, prompt.text.length - tail.length)) === prompt.sha256;
}
