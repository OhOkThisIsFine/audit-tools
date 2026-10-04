#!/usr/bin/env node
// sites-pinned: tests/shared/doc-code-citations-gate.test.ts
// Backticked repo-path citation gate for tracked markdown.
//
// Docs here cite code overwhelmingly as a path in backticks (`src/shared/types/finding.ts`),
// not as a markdown link — and until this gate only the link form was checked
// (`check:doc-links`), so a rename/delete left every backtick citation pointing
// at nothing. The `.mjs`→`.ts` test conversion alone stranded 31 such citations
// across 9 docs, found a week later by a nightly review instead of at the commit
// that renamed the files.
//
// Resolution is against the GIT-TRACKED file set, never `existsSync`: a gate
// that asks the local disk is green on the machine that has the artifact and
// red in a fresh CI clone (the exact false-green/false-red split the doc-links
// gate had to fix). Gitignored citations are scoped out the same way — one
// batched `git check-ignore --stdin` (index/rules-based, fresh-clone stable),
// never a disk probe.
//
// THREE citation classes are checked (sol-4/P29 widened the last two — they
// were previously skipped outright, which both hid stale citations and
// overstated the printed tally):
//
//   • PATH — contains a `/`, first segment is a top-level dir that actually
//     holds tracked files, last segment carries an extension. Must name a
//     tracked file.
//   • DIRECTORY — ends with `/`. Must name a tracked directory (a dir prefix
//     of the tracked set), resolved root-relative first and then relative to
//     the citing doc (`src/audit/README.md` citing `orchestrator/`). Never
//     resolved anywhere-in-tree: a stale `prompts/` must not stay green just
//     because `.github/prompts/` exists somewhere (the P29 defect).
//   • BARE FILENAME — no `/`, carries an extension. Resolved against tracked
//     basenames: no match is red, and so is an ambiguous match (the same
//     basename tracked in two places — cite the full path instead), with ONE
//     tie-break: when exactly one candidate sits at the repo root the citation
//     resolves to it (`README.md` is the repo idiom for the root readme, and a
//     root file has no slashed form to disambiguate with).
//
// Out of scope by rule, not by hand-list:
//   • pattern/placeholder tokens (`*`, `{`, `<`, `>`, `…`) — globs/templates;
//   • non-repo tokens: `~`-homed, drive-lettered (`C:/…`), URL-schemed
//     (`://`), backslashed Windows prose, and `.`/`..` navigation;
//   • the runtime state layout (`.audit-tools/…`) and any gitignored path;
//   • bare names with a leading `.` or `-` (extension-mention idiom: `.ts`,
//     `-outcomes.json`) — the cost is that dotfile citations (`.gitignore`)
//     go unchecked;
//   • bare names whose extension no tracked file uses (`vi.spyOn`,
//     `claude.exe`, `v0.39.4` — method/binary/version mentions);
//   • bare names in the generated run-artifact set
//     (`scripts/shared/runtime-artifact-names.generated.mjs` — extracted from
//     the runtime-layout sources, never a hand list): `repo_manifest.json`
//     names what a run writes, not a repo file.
// A trailing `:123` / `:12-34` / `:~653` line suffix is stripped before
// resolution (line-anchored citations are the repo's normal citation form).
//
// EXEMPTION is explicit and inline, never inferred from prose (the manifest's
// data-not-prose principle): an HTML comment
//     <!-- doc-citation-exempt: <reason> -->
// on the line above (or on the same line as) the citation exempts that line's
// citations. Two legitimate classes need it: third-party repo paths, and
// deliberate "this file does not exist" narrative.
//
// Files matching the doc-manifest `excluded` row (dated review records, runtime
// artifacts, the guidelines file itself) are skipped — same single-sourced set,
// imported from scripts/doc-manifest-data.mjs, never restated here.
//
// What a token IS and whether it RESOLVES lives in
// scripts/shared/code-citation-resolution.mjs, shared with
// `check:comment-code-citations`: this file decides only which docs are read,
// the exemption markers, and the doc-specific rules (line anchors, spec symbols).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DOC_MANIFEST } from "./doc-manifest-data.mjs";
import { globToRegExp, isGlob } from "./check-doc-manifest.mjs";
import { RUNTIME_ARTIFACT_NAMES } from "./shared/runtime-artifact-names.generated.mjs";
import {
  CODE_EXTENSIONS,
  HAS_EXTENSION,
  PATTERN_CHARS,
  RUNTIME_STATE_PREFIXES,
  buildPathIndex,
  classifyPathToken,
  declaredIdentifierUniverse,
  hasLineSuffix,
  ignoreCandidates,
  ignoredPaths,
  isNonRepoToken,
  isSymbolShaped,
  resolvePathRecord,
  stripLineSuffix,
  trackedFiles,
} from "./shared/code-citation-resolution.mjs";

const root = resolve(process.argv[2] ?? process.cwd());

const EXEMPT_MARKER = /<!--\s*doc-citation-exempt:.*?-->/;

/** Paths the doc-manifest `excluded` row names (exact or pattern). */
function excludedMatchers() {
  const row = DOC_MANIFEST.find((r) => r.type === "excluded");
  if (!row) return [];
  return row.files.map(([pattern]) =>
    isGlob(pattern)
      ? globToRegExp(pattern)
      : new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  );
}

/**
 * A line anchor into SOURCE is refused; into anything else it is allowed.
 *
 * Owner preference, 2026-09-06: *"in general we should make citations refer to
 * symbols and not line numbers"*. The reason is decay, not style — a line number
 * is wrong the moment anything is inserted above it, and this gate proves the
 * point: it resolves the PATH and has always thrown the line suffix away, so a
 * citation could rot to a completely unrelated statement and every check stayed
 * green. A symbol name survives every edit that does not rename it, and a rename
 * is exactly when the citation SHOULD break. (`CODE_EXTENSIONS` is the source set.)
 *
 * ⚠ The rule needs NO exclusion list of its own, and adding one would be a second
 * home for a decision the doc manifest already owns. This gate scans only the
 * docs the manifest does not exclude — 54 of 209 tracked markdown files — and the
 * two classes that carry essentially every line anchor are already outside it:
 * generated tool output under the runtime state dirs, and dated review records.
 *
 * Measured 2026-09-06, which is why that matters: 2,781 code line anchors live
 * under the runtime state dirs and 935 in dated review records, against ZERO in
 * the living authored docs this gate reads. So the rule starts green, and it
 * binds exactly the documents a person maintains by hand. To widen it to either
 * class, change the manifest's excluded row — not this file.
 */

const SYMBOL_EXEMPT = /<!--\s*symbol-citation-exempt:.*?-->/;

function main() {
  // `universe` is the RESOLUTION set (tracked + index + untracked non-ignored):
  // a file being authored in this change must resolve as a target. `examined`
  // is what the tree COMMITS to, and it is what decides WHICH citations are
  // looked at — the two must not move together, or an untracked scratch doc
  // changes the verdict of a tree that was green a moment earlier.
  const { examined, universe } = trackedFiles(root);
  const index = buildPathIndex({ examined, universe });
  const runtimeNames = new Set(RUNTIME_ARTIFACT_NAMES);
  const excluded = excludedMatchers();
  // WHICH DOCS ARE READ is a decision about the citations the gate examines, so
  // it reads `examined` — an untracked doc may be CITED (it joins the resolution
  // universe as a target) but must never add citations of its own to the
  // corpus. The first version of this gate built both from `universe`, which
  // <!-- comment-citation-exempt: names the untracked probe doc of a past defect -->
  // made an untracked `spec/zz-probe.md` able to red a green tree with a
  // citation path resolution would never have visited.
  const markdown = examined.filter(
    (p) => p.endsWith(".md") && !excluded.some((re) => re.test(p)),
  );

  // TWO RULES, TWO SCOPES, and the difference is deliberate.
  //
  // Path RESOLUTION runs over `markdown` — the manifest's narrower set — because
  // a dated review record legitimately cites paths that were deleted after it was
  // written, and reddening it for that would make the record unmaintainable.
  //
  // The LINE-ANCHOR rule runs wider, over every tracked doc outside the runtime
  // state dirs, because a dead anchor is not a historical fact the way a deleted
  // path is: it points at whatever now occupies that line number, which is a
  // statement the record never made. Owner decision 2026-09-06, on measurement —
  // of 935 anchors in dated review records, 640 named a path that no longer
  // resolved and every resolvable one sampled pointed at unrelated content:
  // "If the line number citations are meaningless, we should remove them." They
  // were removed; this scope is what stops them coming back.
  //
  // The runtime state dirs stay out because they are generated: the next run
  // rewrites them, so a refusal there would be unfixable by editing.
  const anchorScope = examined.filter(
    (p) => p.endsWith(".md") && !RUNTIME_STATE_PREFIXES.some((s) => p.startsWith(s)),
  );
  const resolutionScope = new Set(markdown);

  // A THIRD RULE, on `spec/**` ONLY: a backticked SYMBOL citation that names
  // nothing in the tree.
  //
  // <!-- comment-citation-exempt: names the mechanism a spec cited after it was deleted; the name is the record -->
  // The wiring is what rots. `spec/remediate/remediation-goals.md` named
  // `dependencyAwaitingClarification` as the held-pending mechanism long after
  // the frontier unification deleted it, and `check:doc-code-citations` stayed
  // green — the gate resolves PATHS and has always ignored a bare identifier.
  // A constitutional doc cannot silently drift from the code it measures while
  // an owner decision is outstanding, so the dangling symbol is surfaced.
  //
  // A WARNING, not a red, and the reason is the message: `spec/**` includes the
  // escalate-only constitutional subset, where a mechanical edit is exactly what
  // the commit gate refuses. Reddening would block a commit the constitution
  // says only an owner may resolve — the gate would be enforcing at a boundary it
  // does not own (PH-05). So it prints, names the file and line, and exits 0;
  // the mechanical part is that it can no longer be INVISIBLE.
  const declaredSymbols = declaredIdentifierUniverse(root, universe);
  const danglingSymbols = [];

  // Pass 1 — collect classified citation records, so gitignore scoping can run
  // as ONE batched git call over every candidate instead of a spawn per token.
  const records = [];
  /** Line anchors into source, collected by the same scan. */
  const lineAnchors = [];
  for (const relPath of anchorScope) {
    const resolves = resolutionScope.has(relPath);
    const lines = readFileSync(join(root, relPath), "utf8").split("\n");
    const isSpec = relPath.startsWith("spec/");
    lines.forEach((line, i) => {
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const token = match[1];
        if (/\s/.test(token) || PATTERN_CHARS.test(token)) continue;
        const path = stripLineSuffix(token).replace(/^\.\//, "");
        if (RUNTIME_STATE_PREFIXES.some((p) => path.startsWith(p))) continue;
        if (isNonRepoToken(path)) continue;

        const exempt =
          EXEMPT_MARKER.test(line) || (i > 0 && EXEMPT_MARKER.test(lines[i - 1]));

        // The SYMBOL rule, `spec/**` only. A token that is a repo path (it has
        // a slash or an extension) is the other rule's business; this one is
        // about the bare identifier a spec names as a mechanism.
        if (isSpec && !path.includes("/") && !HAS_EXTENSION.test(path) && isSymbolShaped(path)) {
          const symbolExempt =
            exempt ||
            SYMBOL_EXEMPT.test(line) ||
            (i > 0 && SYMBOL_EXEMPT.test(lines[i - 1]));
          if (!symbolExempt && !declaredSymbols.has(path)) {
            danglingSymbols.push({ relPath, line: i + 1, token: path });
          }
        }

        // The line-anchor rule rides the same scan: this loop already has the
        // token, the line and the exemption, so a second pass over the corpus
        // would only be a second place to keep in step with this one.
        if (!exempt && hasLineSuffix(token)) {
          const ext = HAS_EXTENSION.exec(path);
          if (ext && CODE_EXTENSIONS.has(ext[1].toLowerCase())) {
            lineAnchors.push({ relPath, line: i + 1, token, path });
          }
        }

        // Past here is PATH RESOLUTION, which keeps the manifest's narrower
        // scope. A doc outside it was read only for the anchor rule above.
        if (!resolves) continue;
        const record = classifyPathToken(token, relPath, index, { skipBareNames: runtimeNames });
        if (record) records.push({ ...record, relPath, line: i + 1, token, exempt });
      }
    });
  }

  const ignored = ignoredPaths(root, ignoreCandidates(records));

  // Pass 2 — resolve. A class counter ticks for every citation the gate actually
  // resolved (green or red); gitignored citations are out of scope, not checked.
  const counts = { path: 0, dir: 0, bare: 0 };
  const failures = [];
  for (const record of records) {
    const result = resolvePathRecord(record, index, ignored);
    if (result === null) continue;
    counts[record.kind] += 1;
    if (!result.ok && !record.exempt) failures.push({ ...record, verdict: result.verdict });
  }

  if (failures.length > 0) {
    console.error(
      `check-doc-code-citations: ${failures.length} backticked citation(s) do not resolve:`,
    );
    for (const f of failures) {
      console.error(`  ${f.relPath}:${f.line}  \`${f.token}\` — ${f.verdict}`);
    }
    console.error(
      "\nFix the citation (the file or directory moved/renamed/was deleted; an ambiguous basename " +
        "needs its full path), or — for a third-party path or deliberate does-not-exist narrative — " +
        "put `<!-- doc-citation-exempt: <reason> -->` on the line above it.",
    );
    process.exit(1);
  }

  if (lineAnchors.length > 0) {
    console.error(
      `check-doc-code-citations: ${lineAnchors.length} citation(s) anchor to a LINE NUMBER in source:`,
    );
    for (const a of lineAnchors) {
      console.error(`  ${a.relPath}:${a.line}  \`${a.token}\``);
    }
    console.error(
      "\nCite the SYMBOL instead — the function, type, constant or export, and the file that holds " +
        "it. A line number is wrong as soon as anything is inserted above it, and this gate resolves " +
        "only the PATH, so a rotted anchor stays green forever. Write `renderContractRepairPrompt` in " +
        "`src/remediate/steps/contractPipelinePrompts.ts`, not `contractPipelinePrompts.ts:566`.\n" +
        "When there is genuinely no symbol to name — a data row, a config line — keep the anchor and " +
        "put `<!-- doc-citation-exempt: <reason> -->` on the line above it, saying what is at that line.",
    );
    process.exit(1);
  }

  // The symbol rule PRINTS but does not fail — see the comment at its collection
  // site. A spec citing a symbol the tree does not carry is surfaced on every run
  // rather than discovered by whoever next reads the doc, which is the property
  // the entry asked for; the escalation stays the owner's, because `spec/**`
  // includes the constitutional subset a mechanical edit may not touch.
  if (danglingSymbols.length > 0) {
    console.warn(
      `⚠ check-doc-code-citations: ${danglingSymbols.length} backticked symbol citation(s) in spec/ ` +
        `name nothing the tree declares:`,
    );
    for (const d of danglingSymbols) {
      console.warn(`  ${d.relPath}:${d.line}  \`${d.token}\``);
    }
    console.warn(
      "The code a spec measures has moved on. Re-point the citation at the symbol that replaced " +
        "it, or — for a design record deliberately naming a retired mechanism — put " +
        "`<!-- symbol-citation-exempt: <what it was> -->` on the line above it. Not a failure: a " +
        "constitutional spec is escalate-only, so only an owner may resolve it.",
    );
  }

  console.log(
    `check-doc-code-citations: ${counts.path} path + ${counts.dir} directory + ` +
      `${counts.bare} bare-filename citation(s) across ${markdown.length} tracked docs — ` +
      `every one resolves, and none anchors to a source line.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
