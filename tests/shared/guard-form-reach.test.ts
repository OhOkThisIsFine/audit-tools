// P51 — a form-recognizing guard's recognized FORMS are declared data, like its
// file reach (owner decision baf2da68fa9cd24f, 2026-09-04, widened to every
// form-recognizing guard).
//
// The defect class: a guard scans 100% of its declared corpus and still misses
// 100% of one syntax — check:memory-citations shipped five reach defects on
// four dates this way, each found by accident. A `forms` entry on a guard row
// is a literal positive sample the guard MUST flag; this test drives the REAL
// recognizer over every declared sample, so a form the guard stops recognizing
// goes red at the next run, and a form declared without teaching the guard goes
// red too — the declaration is the source of truth, not a comment.
//
// Four drivers, chosen per form by its `drive`:
//   script — spawn the gate's script in a throwaway git repo that holds the
//            sample as a tracked file; expect a non-zero exit naming it.
//   export — import the gate's module and call its exported pure recognizer on
//            the sample; expect a non-empty result. Used where the script
//            resolves its tree from its own file location and cannot be pointed
//            at a fixture, or where the recognizer is a pure function anyway.
//   hook   — spawn the hook with a payload carrying the sample on stdin, in a
//            throwaway project root; expect exit 2 naming the rule.
//   test   — the form is pinned by a dedicated harness test that this test
//            cannot cheaply reproduce; the declared sample must still appear in
//            that test, so the two cannot silently drift apart.
import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { GUARDS } from "../../scripts/guard-reach-data.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface FormFixture {
  name: string;
  sample: string;
  drive: "script" | "export" | "hook" | "test";
  expect?: string;
  // script
  script?: string;
  path?: string;
  env?: Record<string, string>;
  fixtureDirs?: string[];
  extraFiles?: Record<string, string>;
  // export
  module?: string;
  exportName?: string;
  call?: "text" | "file-content" | "sources-map";
  fixturePath?: string;
  // hook
  hook?: string;
  payload?: unknown;
  sampleFile?: "transcript-jsonl";
  rootFixture?: string[];
  /** A git repo at the project root: `files` committed, then `unstaged` written over them. */
  rootGit?: { files: Record<string, string>; unstaged?: Record<string, string> };
  // test
  test?: string;
}

interface FormGuard {
  id: string;
  kind: string;
  impl: string;
  forms: FormFixture[];
}

const formGuards = (GUARDS as Array<Record<string, unknown>>).filter(
  (g): g is Record<string, unknown> & FormGuard => Array.isArray(g["forms"]) && (g["forms"] as unknown[]).length > 0,
);

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSyncHidden("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
}

/**
 * The environment a spawned guard sees. Session and kill-switch variables are
 * scrubbed the way the hook tests scrub them: inherited, any one would flip the
 * very behavior a form pins.
 */
function scrubbedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AUDIT_TOOLS_")) delete env[key];
  }
  return { ...env, ...extra };
}

function driveScript(form: FormFixture): { status: number | null; output: string } {
  const repo = tempDir("guard-form-script-");
  git(repo, "init", "--quiet");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "fixture");
  for (const dir of form.fixtureDirs ?? []) mkdirSync(join(repo, dir), { recursive: true });
  for (const [rel, content] of Object.entries(form.extraFiles ?? {})) {
    const extra = join(repo, rel);
    mkdirSync(dirname(extra), { recursive: true });
    writeFileSync(extra, content);
  }
  const file = join(repo, form.path ?? "docs/fixture.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# fixture\n\n${form.sample}\n`);
  git(repo, "add", "-A");
  const env: Record<string, string> = { CLAUDE_PROJECT_DIR: repo };
  for (const [key, value] of Object.entries(form.env ?? {})) {
    env[key] = value.replaceAll("$FIXTURE_ROOT", repo);
  }
  const r = spawnSyncHidden(process.execPath, [join(ROOT, form.script ?? "")], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    env: scrubbedEnv(env),
  });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** A recognizer's result reads as "detected" when it names at least one finding. */
function detected(result: unknown): boolean {
  if (Array.isArray(result)) return result.length > 0;
  if (result && typeof result === "object" && Array.isArray((result as { violations?: unknown }).violations)) {
    return ((result as { violations: unknown[] }).violations).length > 0;
  }
  return Boolean(result);
}

async function driveExport(form: FormFixture): Promise<boolean> {
  const mod = (await import(pathToFileURL(join(ROOT, form.module ?? "")).href)) as Record<string, unknown>;
  const fn = mod[form.exportName ?? ""];
  if (typeof fn !== "function") {
    throw new Error(`${form.module} exports no function named ${form.exportName}`);
  }
  const path = form.fixturePath ?? "src/fixture.ts";
  const call = form.call ?? "text";
  const result: unknown =
    call === "file-content"
      ? fn(path, form.sample)
      : call === "sources-map"
        ? fn(new Map([[path, form.sample]]))
        : fn(form.sample);
  return detected(result);
}

function driveHook(form: FormFixture): { status: number | null; output: string } {
  const root = tempDir("guard-form-hook-");
  for (const rel of form.rootFixture ?? []) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, rel), target);
  }
  if (form.rootGit) {
    // A rule that consults git state (unstaged edits at risk) needs a real repo
    // at the project root, with the fixture files committed and then edited.
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "fixture@example.invalid");
    git(root, "config", "user.name", "fixture");
    for (const [rel, content] of Object.entries(form.rootGit.files)) {
      const target = join(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    git(root, "add", "-A");
    git(root, "commit", "--no-gpg-sign", "--quiet", "-m", "fixture");
    for (const [rel, content] of Object.entries(form.rootGit.unstaged ?? {})) {
      writeFileSync(join(root, rel), content);
    }
  }
  let payloadJson = JSON.stringify(form.payload ?? {});
  if (form.sampleFile === "transcript-jsonl") {
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: form.sample }] },
      })}\n`,
    );
    payloadJson = payloadJson.replaceAll(JSON.stringify("$SAMPLE_FILE"), JSON.stringify(transcript));
  }
  // Inside a JSON string: the sample goes in JSON-escaped, quotes excluded.
  payloadJson = payloadJson.replaceAll("$SAMPLE", JSON.stringify(form.sample).slice(1, -1));
  payloadJson = payloadJson.replaceAll("$SESSION", `guard-form-${Math.random().toString(36).slice(2, 10)}`);
  const r = spawnSyncHidden(process.execPath, [join(ROOT, form.hook ?? "")], {
    input: payloadJson,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    env: scrubbedEnv({ CLAUDE_PROJECT_DIR: root }),
  });
  return { status: r.status, output: `${r.stderr ?? ""}${r.stdout ?? ""}` };
}

describe("guard form reach", () => {
  it("at least one guard declares the forms it must recognize", () => {
    expect(formGuards.length).toBeGreaterThan(0);
  });

  it("every declared form carries the fields its driver needs", () => {
    for (const guard of formGuards) {
      for (const form of guard.forms) {
        const where = `${guard.id} / ${form.name}`;
        expect(typeof form.sample === "string" && form.sample.length > 0, `${where}: sample`).toBe(true);
        switch (form.drive) {
          case "script":
            expect(typeof form.script, `${where}: script`).toBe("string");
            expect(typeof form.expect, `${where}: expect`).toBe("string");
            break;
          case "export":
            expect(typeof form.module, `${where}: module`).toBe("string");
            expect(typeof form.exportName, `${where}: exportName`).toBe("string");
            break;
          case "hook":
            expect(typeof form.hook, `${where}: hook`).toBe("string");
            expect(form.payload !== undefined, `${where}: payload`).toBe(true);
            expect(typeof form.expect, `${where}: expect`).toBe("string");
            break;
          case "test":
            expect(typeof form.test, `${where}: test`).toBe("string");
            break;
          default:
            throw new Error(`${where}: unknown drive ${String(form.drive)}`);
        }
      }
    }
  });

  for (const guard of formGuards) {
    for (const form of guard.forms) {
      it(`${guard.id} still recognizes the ${form.name} form`, async () => {
        switch (form.drive) {
          case "script": {
            const r = driveScript(form);
            expect(r.status, `exit code; output was:\n${r.output}`).not.toBe(0);
            expect(r.output).toContain(form.expect);
            break;
          }
          case "export": {
            expect(await driveExport(form), `${form.exportName} did not flag the sample`).toBe(true);
            break;
          }
          case "hook": {
            const r = driveHook(form);
            expect(r.status, `exit code; output was:\n${r.output}`).toBe(2);
            expect(r.output).toContain(form.expect);
            break;
          }
          case "test": {
            const text = readFileSync(join(ROOT, form.test ?? ""), "utf8");
            expect(text, `${form.test} no longer carries the declared sample`).toContain(form.sample);
            break;
          }
        }
      });
    }
  }
});
