import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { ingestAnswers } from "../../scripts/nightly/ingest-answers.mjs";
import { checkInbox, writeInbox } from "../../scripts/nightly/render-inbox.mjs";
import { DECISIONS_RELPATH, INBOX_RELPATH, OPEN_ITEMS_RELPATH, OPEN_ITEMS_INDEX_RELPATH, readDecisions } from "../../scripts/nightly/items.mjs";

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

it("prints usage or rejects invalid invocations before reading corrupt inputs", () => {
  saveStoredQueue();
  const ledger = join(root, DECISIONS_RELPATH);
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(ledger, "{invalid ledger");
  writeFileSync(join(root, OPEN_ITEMS_RELPATH), "{invalid queue");
  for (const args of [[], ["--help"]]) {
    const result = answer(...args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage:");
  }
  for (const args of [["--list", "--settled"], ["A", "--wontfix", "--question", "prose"]]) {
    const result = answer(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Choose one mode");
  }
  const invalid = [
    { args: ["--question"], status: 1, error: "Not an item id" },
    { args: ["A", "--wontfix"], status: 1, error: "An answer is required" },
    { args: ["--"], status: 1, error: "Not an item id" },
    { args: ["--done"], status: 1, error: "--done needs a SUBJECT KEY" },
    { args: ["--done", "key"], status: 1, error: "--done needs a ref" },
    { args: ["--list", "bogus"], status: 2, error: "--list does not take positional arguments" },
  ];
  for (const { args, status, error } of invalid) {
    const result = answer(...args);
    expect(result.status).toBe(status);
    expect(result.stderr).toContain(error);
  }
  expect(readFileSync(ledger, "utf8")).toBe("{invalid ledger");
  expect(readFileSync(join(root, OPEN_ITEMS_RELPATH), "utf8")).toBe("{invalid queue");
});

it("reads only the decisions for --settled, even when the stored queue is corrupt", () => {
  const [a] = saveStoredQueue();
  const recorded = answer(a.id, "Keep the proposal");
  expect(recorded.status, recorded.stderr).toBe(0);
  writeFileSync(join(root, OPEN_ITEMS_RELPATH), "{invalid queue");
  const settled = answer("--settled");
  expect(settled.status, settled.stderr).toBe(0);
  expect(settled.stdout).toContain(a.subject_key);
  expect(answer("--list").stderr).toContain("Cannot read stored queue");
});

it("dispatches --done by its parsed mode and preserves the queue projection", () => {
  const [a] = saveStoredQueue();
  const recorded = answer(a.id, "Keep the proposal");
  expect(recorded.status, recorded.stderr).toBe(0);
  const completed = answer(a.subject_key, "--done", "landed");
  expect(completed.status, completed.stderr).toBe(0);
  expect(readDecisions(root)[a.subject_key].completed_ref).toBe("landed");
  expect(checkInbox(root).fresh).toBe(true);
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
