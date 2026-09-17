// What `parseDispatchAnswer` hands a caller as `body` must be the LANE'S OWN
// ANSWER (nightly proposal P66, owner decision 2026-09-16).
//
// The relay renders a reply as: the `key: value` header, then — when its lane
// walk is on — a `lanes tried:` paragraph, then the lane's output, then — when
// the running MCP server is older than the installed one — a version notice.
// For a CLI rung the lane's output is itself a conversation ENVELOPE whose
// `response` field holds the answer. A caller that parses `body` as its own
// contract read the envelope's fields and recorded the call as an error: 19 of
// 62 entries on the 2026-09-16 sweep.
import { describe, expect, it } from "vitest";

import { parseDispatchAnswer } from "../../scripts/shared/mcp-dispatch-lane.mjs";

const ANSWER = '{"verdict":"actionable_now","why":"w","action":"a"}';

const HEADER = ["job: job-0001", "lane: agy-gemini", "status: completed", "elapsed: 8s", "exit: 0"].join("\n");

const ENVELOPE = JSON.stringify({
  conversation_id: "cdbbbf28-6adb-4066-9757-779599c59669",
  status: "SUCCESS",
  response: ANSWER + "\n",
  duration_seconds: 3.44,
  num_turns: 1,
  usage: { input_tokens: 20425, output_tokens: 412 },
});

const LANES_TRIED = "lanes tried:\n  1. free-pool (pool/medium): abandoned after 90s — the walk's budget\n  2. agy-gemini: completed after 8s";

const VERSION_NOTICE =
  "⚠ This llm-relay MCP server process runs v0.81.0, but v0.82.2 is installed. " +
  "Restart the host's llm-relay MCP connection, or the host, to use the installed code.";

describe("a CLI lane's answer arrives inside a conversation envelope", () => {
  it("returns the lane's own answer as the body, not the envelope", () => {
    const { lane, body } = parseDispatchAnswer(`${HEADER}\n\n${ENVELOPE}`);

    expect(lane).toBe("agy-gemini");
    expect(body).toBe(ANSWER);
  });

  it("unwraps the envelope in the reply shape the relay really renders: lanes tried before it, a version notice after it", () => {
    const parsed = parseDispatchAnswer(`${HEADER}\n\n${LANES_TRIED}\n\n${ENVELOPE}\n\n${VERSION_NOTICE}`);

    expect(parsed.body).toBe(ANSWER);
    // Provenance is kept, not dropped: it moves out of the answer.
    expect(parsed.lanesTried).toBe(LANES_TRIED);
    expect(parsed.notice).toBe(VERSION_NOTICE);
  });

  it("keeps the relay's own paragraphs out of a raw-answer lane's body too", () => {
    const parsed = parseDispatchAnswer(
      `job: job-0002\nlane: free-pool (pool/medium)\nstatus: completed\n\n${LANES_TRIED}\n\n${ANSWER}\n\n${VERSION_NOTICE}`,
    );

    expect(parsed.body).toBe(ANSWER);
  });

  it("passes a raw-answer body through unchanged, blank lines included", () => {
    const prose = "First paragraph.\n\nSecond paragraph, with {braces} in it.";

    expect(parseDispatchAnswer(`${HEADER}\n\n${prose}`).body).toBe(prose);
    expect(parseDispatchAnswer(`${HEADER}\n\n${ANSWER}`).body).toBe(ANSWER);
  });

  it("does not unwrap a JSON answer that only LOOKS like half an envelope", () => {
    // `response` without `conversation_id`, and the reverse: a caller's own
    // schema may name either field. Only the declared pair is the envelope.
    const onlyResponse = '{"response":"mine","verdict":"x"}';
    const onlyConversation = '{"conversation_id":"c-1","verdict":"x"}';
    const nonStringResponse = '{"conversation_id":"c-1","response":{"nested":true}}';

    for (const mine of [onlyResponse, onlyConversation, nonStringResponse]) {
      expect(parseDispatchAnswer(`${HEADER}\n\n${mine}`).body).toBe(mine);
    }
  });
});
