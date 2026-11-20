import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { ingestAnswers } from "../../scripts/nightly/ingest-answers.mjs";
import { checkInbox, writeInbox } from "../../scripts/nightly/render-inbox.mjs";
import { INBOX_RELPATH, OPEN_ITEMS_RELPATH, OPEN_ITEMS_INDEX_RELPATH, readDecisions } from "../../scripts/nightly/items.mjs";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "stored-queue-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function saveStoredQueue() {
  const items = ["A", "B"].map((id, i) => ({
    id, leg: "solutions", title: "Stored proposal " + id, subject_key: String(i + 1).repeat(16),
    patch_path: ".audit-tools/nightly/proposals/" + id + "/PROPOSAL.md",
    question: "Keep this proposal?", options: [{ label: "Accept", answer: "Keep it." }],
  }));
  for (const item of items) {
    mkdirSync(join(root, ".audit-tools/nightly/proposals", item.id), { recursive: true });
    writeFileSync(join(root, item.patch_path), item.title);
  }
  writeFileSync(join(root, OPEN_ITEMS_RELPATH), JSON.stringify({ run: "stored", items, applied: [], skipped: [] }));
  return items;
}

function answer(...args: string[]) {
  const cli = join(import.meta.dirname, "../../scripts/nightly/answer.mjs");
  return spawnSyncHidden(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
}

it("treats disposition flags after the delimiter as literal answer text", () => {
  const [a] = saveStoredQueue();
  const result = answer("A", "--", "--question", "--wontfix");
  expect(result.status, result.stderr).toBe(0);
  expect(readDecisions(root)[a.subject_key]).toMatchObject({ disposition: "settled", answer: "--question --wontfix" });
});

it("refuses a missing or corrupt queue without manufacturing an empty snapshot", () => {
  expect(() => writeInbox(root)).toThrow(/open-items\.json/);
  expect(existsSync(join(root, OPEN_ITEMS_RELPATH))).toBe(false);
  saveStoredQueue();
  writeFileSync(join(root, OPEN_ITEMS_RELPATH), "{invalid");
  expect(() => writeInbox(root)).toThrow(/open-items\.json/);
  expect(readFileSync(join(root, OPEN_ITEMS_RELPATH), "utf8")).toBe("{invalid");
});

it("recovers a failed index write from the stored queue and accepted ledger", () => {
  const [a, b] = saveStoredQueue();
  writeInbox(root);
  const snapshot = readFileSync(join(root, OPEN_ITEMS_RELPATH), "utf8");
  const index = join(root, OPEN_ITEMS_INDEX_RELPATH);
  rmSync(index);
  mkdirSync(index);
  const failed = answer("A", "Keep the proposal");
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("Decisions saved");
  expect(failed.stderr).toContain("render-inbox.mjs");
  const accepted = readDecisions(root)[a.subject_key];
  expect(accepted.answer).toBe("Keep the proposal");
  expect(readFileSync(join(root, OPEN_ITEMS_RELPATH), "utf8")).toBe(snapshot);
  rmSync(index, { recursive: true });
  writeInbox(root);
  writeInbox(root);
  expect(readDecisions(root)[a.subject_key]).toEqual(accepted);
  expect(JSON.parse(readFileSync(join(root, OPEN_ITEMS_RELPATH), "utf8")).items).toEqual([b]);
  expect(JSON.parse(readFileSync(index, "utf8")).items.map((item: {id: string}) => item.id)).toEqual(["B"]);
  expect(readFileSync(join(root, INBOX_RELPATH), "utf8")).toContain(b.patch_path);
  expect(answer("--done", a.subject_key, "landed").status).toBe(0);
  expect(checkInbox(root).fresh).toBe(true);
  expect(readFileSync(join(root, a.patch_path), "utf8")).toBe(a.title);
});

it("preserves every ticked answer when projecting a saved inbox fails", () => {
  const saved = saveStoredQueue();
  writeInbox(root);
  const inbox = join(root, INBOX_RELPATH);
  writeFileSync(inbox, readFileSync(inbox, "utf8").replaceAll("- [ ] **1. Accept**", "- [x] **1. Accept**"));
  const index = join(root, OPEN_ITEMS_INDEX_RELPATH);
  rmSync(index);
  mkdirSync(index);
  expect(() => ingestAnswers(root)).toThrow();
  const recorded = readDecisions(root);
  for (const item of saved) expect(recorded[item.subject_key].answer).toBe("Keep it.");
  rmSync(index, { recursive: true });
  ingestAnswers(root);
  expect(readDecisions(root)).toEqual(recorded);
  expect(JSON.parse(readFileSync(join(root, OPEN_ITEMS_RELPATH), "utf8")).items).toEqual([]);
  expect(checkInbox(root).fresh).toBe(true);
});
