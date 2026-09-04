// The published tarball is a doc surface of its own, and it was drifting from
// the repo's: `docs/audit-pkg/**` shipped every page under it, so the
// contributor guide and the maintainer release runbook reached npm consumers,
// while every doc they pointed at (`CLAUDE.md`, `spec/`, `docs/HANDOFF.md`,
// `docs/backlog.md`) stayed behind. A pointer that leaves the shipped set is a
// dead end for the only reader who cannot see the repo.
//
// Six properties, all mechanical:
//   1. the shipped doc set is the consumer-facing one — the contributor guide
//      and release runbook stay repo-internal;
//   2. no relative link in a shipped markdown file leaves the shipped set;
//   3. README's guide list names exactly the shipped `docs/` pages;
//   4. every absolute GitHub URL in a shipped page names the declared repository;
//   5. every fragment on a relative link resolves to a heading in the target;
//   6. the target-directory rule is stated once — in the loader prompt only.
//
// (2) is what actually keeps (1) honest over time: narrowing the set without it
// converts a working link into a 404 nobody in the repo can observe, because
// every target still resolves on disk. (3) closes the same hole on the other
// side: README enumerated the shipped pages in prose, which is a list
// package.json `files` already decides, so adding or dropping a consumer page
// left the sentence wrong with nothing red. (4) binds the repository slug the
// escaping-link rule forces those pages to spell out — six copies of one string
// whose home is package.json `repository`. (5) is the other half of a one-home
// pointer: collapsing a duplicated instruction into `page.md#heading` makes the
// anchor load-bearing, and check-doc-links strips fragments before resolving.
// (6) is that collapse's other half: SKILL.md restated the `--root <path>` rule
// the loader prompt already owned, and the two drifted independently. The skill
// now points at the prompt, which nothing kept true.
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { execFileSyncHidden } from "../helpers/spawn.mjs";
// The text recognizers live in the shared helper so the guard-form-reach test
// can drive the REAL matchers over each declared sample (P51).
import {
  absoluteGitHubSlugs,
  headingAnchors,
  relativeLinkTargets,
} from "../helpers/recognizers.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  files: string[];
  repository?: { url?: string };
};

/** `owner/repo`, from the one declaration npm itself publishes. */
const repositorySlug = (() => {
  const declared = packageJson.repository?.url ?? "";
  const match = /github\.com[/:]([^/\s]+)\/([^/\s.]+)/.exec(declared);
  if (match === null) throw new Error(`package.json declares no GitHub repository url (got "${declared}")`);
  return `${match[1]}/${match[2]}`;
})();

/** Tracked files, POSIX-separated — a fresh CI clone must see the same set. */
function trackedFiles(): string[] {
  return execFileSyncHidden("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"));
}

/**
 * One `files` pattern → a matcher over repo-relative POSIX paths.
 *
 * npm's rules, narrowed to the forms this manifest uses: `**` spans path
 * separators, `*` stays inside one segment, and a pattern naming a directory
 * ships everything beneath it.
 */
function matcherFor(pattern: string): (path: string) => boolean {
  // Scanned character by character rather than chained replaces: a placeholder
  // for `**` between passes is itself a character the next pass can rewrite.
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 1;
    } else if (pattern[index] === "*") {
      source += "[^/]*";
    } else {
      source += pattern[index].replace(/[.+^${}()|[\]\\?]/g, "\\$&");
    }
  }
  const exact = new RegExp(`^${source}$`);
  const underDirectory = new RegExp(`^${source}/`);
  return (path) => exact.test(path) || underDirectory.test(path);
}

// npm ships these regardless of `files`; nothing else is implicit.
const ALWAYS_SHIPPED = new Set(["package.json", "LICENSE", "LICENSE.md", "README.md"]);
const MATCHERS = packageJson.files.map(matcherFor);

function isShipped(path: string): boolean {
  return ALWAYS_SHIPPED.has(path) || MATCHERS.some((matches) => matches(path));
}

const shippedMarkdown = trackedFiles().filter((file) => file.endsWith(".md") && isShipped(file));


describe("the published tarball carries a coherent, self-contained doc set", () => {
  it("ships the consumer-facing package pages and no repo-internal ones", () => {
    const shippedPackageDocs = shippedMarkdown.filter((file) => file.startsWith("docs/"));
    expect(shippedPackageDocs.sort()).toEqual([
      "docs/audit-pkg/contracts.md",
      "docs/audit-pkg/operator-guide.md",
      "docs/audit-pkg/product.md",
    ]);
  });

  it("keeps the contributor guide and the release runbook out of the tarball", () => {
    // Both stay TRACKED — only the tarball narrows; repo readers still need them.
    const tracked = new Set(trackedFiles());
    for (const repoOnly of ["docs/audit-pkg/development.md", "docs/audit-pkg/release.md"]) {
      expect(tracked.has(repoOnly), `${repoOnly} must stay in the repository`).toBe(true);
      expect(isShipped(repoOnly), `${repoOnly} must not ship`).toBe(false);
    }
  });

  it("keeps README's guide list equal to the shipped package pages", () => {
    // README is itself shipped, so rule (2) already forbids it a relative link
    // to an unshipped page; pinning equality adds the missing half — a shipped
    // page README does not name.
    // Normalized BEFORE the filter: a bullet written `./docs/audit-pkg/x.md`
    // would otherwise be invisible here, and the escaping-link rule would not
    // catch it either — the target IS shipped, it is only spelled differently.
    const readmeDocLinks = relativeLinkTargets(readFileSync(join(REPO_ROOT, "README.md"), "utf8"))
      .map((target) => posix.normalize(target.split("#")[0]))
      .filter((target) => target.startsWith("docs/"));
    const shippedPackageDocs = shippedMarkdown.filter((file) => file.startsWith("docs/"));
    expect([...new Set(readmeDocLinks)].sort()).toEqual(shippedPackageDocs.sort());
  });

  it("spells every absolute repository URL with the declared repository slug", () => {
    const wrong: string[] = [];
    for (const file of shippedMarkdown) {
      for (const slug of absoluteGitHubSlugs(readFileSync(join(REPO_ROOT, file), "utf8"))) {
        if (slug !== repositorySlug) wrong.push(`${file} → ${slug}`);
      }
    }
    // A page that cannot use a relative link must use an absolute one, so the
    // owner/repo string spreads across the shipped set; package.json owns it.
    expect(wrong).toEqual([]);
  });

  it("resolves every relative link fragment against a heading in the target page", () => {
    // The one-home pointers this set depends on are deep links (operator-guide
    // → product.md#supported-surfaces). check:doc-links strips the fragment and
    // never validates the anchor, so a heading rename would silently break the
    // pointer while every gate stayed green.
    const broken: string[] = [];
    let checked = 0;
    for (const file of shippedMarkdown) {
      const from = posix.dirname(file);
      for (const target of relativeLinkTargets(readFileSync(join(REPO_ROOT, file), "utf8"))) {
        const [path, fragment] = target.split("#");
        if (fragment === undefined || fragment === "") continue;
        const resolved = path === "" ? file : posix.normalize(posix.join(from, path));
        if (!resolved.endsWith(".md") || !isShipped(resolved)) continue; // rule (2) owns those
        checked += 1;
        const anchors = headingAnchors(readFileSync(join(REPO_ROOT, resolved), "utf8"));
        if (!anchors.has(fragment.toLowerCase())) broken.push(`${file} → ${target}`);
      }
    }
    expect(broken).toEqual([]);
    // Success-shaped empty: the shipped set relies on at least one deep link
    // (operator-guide → product.md#supported-surfaces). Zero means the parse
    // stopped seeing them, not that they all resolve.
    expect(checked, "no shipped fragment link was examined").toBeGreaterThan(0);
  });

  it("states the target-directory rule once, in the loader prompt the skill points at", () => {
    // Both assets ship (`skills/**`), so an npm reader sees both copies. The
    // rule is spelled as the flag itself: a second statement anywhere reads as
    // authoritative, and the pair drifts with nothing red.
    const occurrences = (file: string): number =>
      readFileSync(join(REPO_ROOT, "skills", "audit-code", file), "utf8").split("--root <path>").length - 1;
    expect(occurrences("SKILL.md"), "the skill must point at the prompt, not restate the rule").toBe(0);
    expect(occurrences("audit-code.prompt.md"), "the loader prompt owns exactly one statement").toBe(1);
  });

  it("leaves no relative link in a shipped page pointing outside the shipped set", () => {
    const escaping: string[] = [];
    for (const file of shippedMarkdown) {
      const from = posix.dirname(file);
      for (const target of relativeLinkTargets(readFileSync(join(REPO_ROOT, file), "utf8"))) {
        const [path] = target.split("#");
        if (path === "") continue; // pure fragment
        const resolved = posix.normalize(posix.join(from, path)).replace(/\/$/, "");
        if (!isShipped(resolved)) escaping.push(`${file} → ${target}`);
      }
    }
    // A shipped page may only point at another shipped path; anything the npm
    // reader cannot open must be an absolute URL instead.
    expect(escaping).toEqual([]);
  });
});
