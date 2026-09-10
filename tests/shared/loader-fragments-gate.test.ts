/**
 * Contract test for `check:loader-fragments` (scripts/check-loader-fragments.mjs)
 * and its data module (scripts/shared/loader-fragments-data.mjs).
 *
 * The gate reconciles the four shipped loader assets against declared canonical
 * fragments, holding the property from minor-bugs ("The remediate loader pair
 * restates what the audit pair now single-sources", 2026-08-23): across a loader
 * pair, each instruction has ONE full statement and the other asset points at
 * it, while a genuinely universal paragraph is verbatim in all four.
 *
 * PINNED IN BOTH POLARITIES. A gate that only ever sees a consistent tree is a
 * gate nobody has watched fire: the fixtures below drive the pure
 * `checkLoaderFragments` over synthetic trees, so each failure MODE is exercised
 * rather than assumed. The last case runs the real gate over the real tree,
 * which is the half that would catch a genuinely drifted asset.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLoaderFragments } from "../../scripts/check-loader-fragments.mjs";
import {
  LOADER_FRAGMENTS,
  loaderFragmentAssets,
  normalizeFragmentText,
  pointerPhrase,
} from "../../scripts/shared/loader-fragments-data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const HOME = "skills/a/a.prompt.md";
const POINTER = "skills/a/SKILL.md";
const OTHER = "skills/b/b.prompt.md";

const RULE = "Do the thing; it is stated once.";

const UNIVERSAL = "Read only the prompt path.";

const FRAGMENTS = [
  // Axis 1: stated once in the home, the peer points at it.
  { id: "stated-once", verbatimIn: [HOME], pointers: [{ path: POINTER, home: HOME }], text: RULE },
  // Axis 2: one shared fragment rendered into several bodies.
  { id: "everywhere", verbatimIn: [HOME, POINTER, OTHER], text: UNIVERSAL },
];

/** A synthetic tree; an override map replaces a path's whole content. */
function tree(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    [HOME]: `Header.\n\n${UNIVERSAL}\n\n${RULE}\n`,
    [POINTER]: `Header.\n\n${UNIVERSAL}\n\nThis rule has ${pointerPhrase(HOME)}; follow it as written there.\n`,
    [OTHER]: `Header.\n\n${UNIVERSAL}\n`,
  };
  return (path: string) => overrides[path] ?? base[path] ?? "";
}

describe("check:loader-fragments — the gate fires in both polarities", () => {
  it("passes a consistent tree", () => {
    expect(checkLoaderFragments({ fragments: FRAGMENTS, readFile: tree() })).toEqual([]);
  });

  it("fails when a verbatim carrier drops its statement", () => {
    const failures = checkLoaderFragments({
      fragments: FRAGMENTS,
      readFile: tree({ [HOME]: "Header only.\n" }),
    });
    expect(failures.join("\n")).toMatch(
      /stated-once: skills\/a\/a\.prompt\.md must carry the canonical fragment verbatim/,
    );
  });

  it("fails when a shared (axis-2) fragment is missing from ONE of its bodies", () => {
    // The target-directory shape: both loader bodies must state it, so a body
    // that carries only the pointer is a half-landed single-source.
    const failures = checkLoaderFragments({
      fragments: FRAGMENTS,
      readFile: tree({ [OTHER]: "Header only.\n" }),
    });
    expect(failures.join("\n")).toMatch(/everywhere: skills\/b\/b\.prompt\.md must carry/);
  });

  it("fails when a pointer RESTATES the rule instead of pointing at the home", () => {
    // The exact drift this gate exists for: the second copy looks authoritative.
    const failures = checkLoaderFragments({
      fragments: FRAGMENTS,
      readFile: tree({ [POINTER]: `Header.\n\n${RULE}\n` }),
    });
    expect(failures.join("\n")).toMatch(/stated-once: .* must point at/);
  });

  it("fails when a pointer both points AND restates", () => {
    const failures = checkLoaderFragments({
      fragments: FRAGMENTS,
      readFile: tree({
        [POINTER]: `This rule has ${pointerPhrase(HOME)}; follow it as written there.\n\n${RULE}\n`,
      }),
    });
    expect(failures.join("\n")).toMatch(/stated-once: .* both points at .* AND restates/);
  });

  it("fails when an unrelated asset picks up the rule (the home is the ONLY statement)", () => {
    const failures = checkLoaderFragments({
      fragments: FRAGMENTS,
      readFile: tree({ [OTHER]: `Read only the prompt path.\n\n${RULE}\n` }),
    });
    expect(failures.join("\n")).toMatch(/stated-once: .* restates the rule instead of pointing at/);
  });

  it("fails when a verbatim fragment is reworded in any asset", () => {
    const failures = checkLoaderFragments({
      fragments: FRAGMENTS,
      readFile: tree({ [OTHER]: "Read only the prompt path (changed).\n" }),
    });
    expect(failures.join("\n")).toMatch(/everywhere: .* must carry the canonical fragment verbatim/);
  });

  it("compares whitespace-normalized, so a re-wrap is NOT drift", () => {
    const failures = checkLoaderFragments({
      fragments: FRAGMENTS,
      readFile: tree({ [OTHER]: "Read only the\nprompt    path.\n" }),
    });
    expect(failures, "markdown line breaks are presentation, not meaning").toEqual([]);
  });
});

describe("check:loader-fragments — the declarations and the real tree", () => {
  it("the shipped assets all pass the real gate", () => {
    const failures = checkLoaderFragments({
      readFile: (path: string) => readFileSync(join(repoRoot, path), "utf8"),
    });
    expect(
      failures,
      "a shipped loader asset drifted from its canonical fragment — see " +
        "scripts/shared/loader-fragments-data.mjs",
    ).toEqual([]);
  });

  it("every declared fragment is anchored to a real, tracked asset", () => {
    // A declaration naming a file that does not exist would pass the gate
    // vacuously (every `includes` on "" is false, so the failure WOULD fire) —
    // but a typo'd home that happens to be another asset's path would not.
    for (const path of loaderFragmentAssets()) {
      expect(() => readFileSync(join(repoRoot, path), "utf8"), `${path} must exist`).not.toThrow();
    }
    for (const fragment of LOADER_FRAGMENTS) {
      expect(fragment.text.trim().length, `${fragment.id} must declare text`).toBeGreaterThan(0);
      expect(
        (fragment.verbatimIn ?? []).length,
        `${fragment.id} must declare at least one verbatimIn carrier`,
      ).toBeGreaterThan(0);
      // A pointer must name a declared carrier, or the phrase it pins points at
      // an asset the check never reconciles.
      for (const pointer of fragment.pointers ?? []) {
        expect(
          fragment.verbatimIn.includes(pointer.home),
          `${fragment.id}: pointer ${pointer.path} names ${pointer.home}, which is not a carrier`,
        ).toBe(true);
      }
    }
  });

  it("normalizeFragmentText collapses wraps without touching content", () => {
    expect(normalizeFragmentText("a  b\n c")).toBe("a b c");
    expect(normalizeFragmentText("`code`  spans")).toBe("`code` spans");
  });
});
