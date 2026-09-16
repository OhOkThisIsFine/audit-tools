// RED-AT probe for nightly proposal P66. Authored 2026-09-16 to observe the
// failure at HEAD before the proposal claims it. Not a permanent test here —
// it ships inside .audit-tools/nightly/proposals/P66-dispatch-lane-envelope/.
import { describe, expect, it } from "vitest";

// @ts-expect-error — the helper is plain .mjs with JSDoc types only.
import { parseDispatchAnswer } from "../../scripts/shared/mcp-dispatch-lane.mjs";

const ANSWER = '{"verdict":"actionable_now","why":"w","action":"a"}';

const CLI_LANE_REPLY = [
  "job: job-0001",
  "lane: agy-gemini",
  "status: completed",
  "elapsed: 8s",
  "exit: 0",
  "",
  JSON.stringify({
    conversation_id: "cdbbbf28-6adb-4066-9757-779599c59669",
    status: "SUCCESS",
    response: ANSWER + "\n",
    duration_seconds: 3.44,
    num_turns: 1,
    usage: { input_tokens: 20425, output_tokens: 412 },
  }),
].join("\n");

describe("a CLI lane's answer arrives inside a conversation envelope", () => {
  it("returns the lane's own answer as the body, not the envelope", () => {
    const { lane, body } = parseDispatchAnswer(CLI_LANE_REPLY);
    expect(lane).toBe("agy-gemini");
    // At HEAD `body` is the whole envelope, so every caller that parses the
    // body as its own contract reads `conversation_id`/`status`/`response`
    // and finds none of its required fields.
    expect(JSON.parse(body)).toEqual({
      verdict: "actionable_now",
      why: "w",
      action: "a",
    });
  });
});
