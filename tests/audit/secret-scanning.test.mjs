import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { detectSecrets, shannonEntropy } = await import(
  "../../src/shared/secrets.ts"
);
const { scanSecretsArtifact, secretRiskSignals, secretFindings } = await import(
  "../../src/audit/extractors/secrets.ts"
);
const { mergeAnalyzerRiskSignals } = await import(
  "../../src/audit/extractors/risk.ts"
);
const { runStructureExecutor } = await import(
  "../../src/audit/orchestrator/structureExecutors.ts"
);
const { buildRepoManifestFromFs } = await import(
  "../../src/audit/extractors/fsIntake.ts"
);
const { ARTIFACT_DEPENDS_ON_MAP } = await import(
  "../../src/audit/orchestrator/dependencyMap.ts"
);

const manifest = (paths) => ({
  files: paths.map((path) => ({
    path,
    size_bytes: 64,
    language: "typescript",
    excluded: false,
  })),
});

// A real-looking AWS key (format match, not a heuristic). Deliberately not a
// live credential.
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

// inv-1: the secret extractor is owned + purely mechanical — it runs the shared
// detector ONLY and must never reach into the F5 analyzer / adapter seam.
test("inv-1: secrets extractor imports no F5 analyzer/adapter seam", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(
    join(here, "../../src/audit/extractors/secrets.ts"),
    "utf8",
  );
  const importLines = src
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+["']/.test(line));
  for (const line of importLines) {
    assert.doesNotMatch(line, /extractors\/analyzers/, line.trim());
    assert.doesNotMatch(line, /\.\.\/adapters\//, line.trim());
  }
  assert.match(src, /from\s+["']audit-tools\/shared["']/);
});

// inv-7: secrets.json declares upstream deps exactly {repo_manifest, file_disposition}.
test("inv-7: secrets.json declares upstream deps exactly {repo_manifest, file_disposition}", () => {
  assert.deepEqual(
    [...(ARTIFACT_DEPENDS_ON_MAP["secrets.json"] ?? [])].sort(),
    ["file_disposition.json", "repo_manifest.json"],
  );
});

test("detectSecrets is pure, never throws, and degrades to empty", () => {
  assert.deepEqual(detectSecrets("a.ts", ""), []);
  assert.deepEqual(detectSecrets("a.ts", "const x = 1;\nconst y = 2;\n"), []);
});

test("detectSecrets finds a provider token and masks the value", () => {
  const found = detectSecrets("config.ts", `const key = "${AWS_KEY}";`);
  assert.equal(found.length, 1);
  assert.equal(found[0].rule_id, "aws-access-key-id");
  assert.equal(found[0].line, 1);
  assert.equal(found[0].severity, "high");
  // Masked: never carries the raw secret.
  assert.doesNotMatch(found[0].masked_excerpt, new RegExp(AWS_KEY));
  assert.match(found[0].masked_excerpt, /…/);
});

test("detectSecrets entropy gate: credential-named high-entropy value flags; placeholder/low-entropy do not", () => {
  const high = detectSecrets(
    "s.ts",
    `apiKey = "Zx9Qw3Lm7Pv2Tk8Rb4Nc6Hd1Yf5Ga0"`,
  );
  assert.equal(high.length, 1);
  assert.equal(high[0].rule_id, "high-entropy-assignment");

  // Placeholder value — skipped.
  assert.deepEqual(detectSecrets("s.ts", `apiKey = "your-api-key-here"`), []);
  // Non-credential name — skipped even if high entropy.
  assert.deepEqual(
    detectSecrets("s.ts", `nonce = "Zx9Qw3Lm7Pv2Tk8Rb4Nc6Hd1Yf5Ga0"`),
    [],
  );
  // Low-entropy repeated value — skipped.
  assert.deepEqual(detectSecrets("s.ts", `password = "aaaaaaaaaaaaaaaaaaaa"`), []);
});

test("detectSecrets output is deterministic and sorted by (line, rule_id)", () => {
  const content = `gh = "ghp_${"a".repeat(36)}"\nak = "${AWS_KEY}"`;
  const a = detectSecrets("f.ts", content);
  const b = detectSecrets("f.ts", content);
  assert.deepEqual(a, b);
  assert.equal(a[0].line, 1);
  assert.equal(a[1].line, 2);
});

test("shannonEntropy: empty is 0, uniform random is high, repeated is low", () => {
  assert.equal(shannonEntropy(""), 0);
  assert.ok(shannonEntropy("aaaaaaaa") < 0.001);
  assert.ok(shannonEntropy("Zx9Qw3Lm7Pv2Tk8Rb4Nc6Hd1Yf5Ga0") > 4);
});

test("scanSecretsArtifact scopes to in-scope files and degrades to empty without findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secret-scan-"));
  try {
    await writeFile(join(dir, "leak.ts"), `const k = "${AWS_KEY}";`, "utf8");
    await writeFile(join(dir, "clean.ts"), `const k = 42;`, "utf8");
    const repo = manifest(["leak.ts", "clean.ts"]);
    const scan = scanSecretsArtifact(dir, repo);
    assert.equal(scan.findings.length, 1);
    assert.equal(scan.findings[0].path, "leak.ts");

    // Excluded file is not scanned.
    const repoExcluded = {
      files: [{ path: "leak.ts", size_bytes: 64, language: "typescript", excluded: true }],
    };
    assert.deepEqual(scanSecretsArtifact(dir, repoExcluded).findings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secretRiskSignals raises hardcoded_secret on the unit owning a flagged file", () => {
  const scan = { findings: [{ rule_id: "aws-access-key-id", title: "AWS", path: "leak.ts", line: 1, severity: "high", confidence: "high", masked_excerpt: "AKIA…LE" }] };
  const unitManifest = {
    units: [
      { unit_id: "u1", files: ["leak.ts", "other.ts"] },
      { unit_id: "u2", files: ["clean.ts"] },
    ],
  };
  const signals = secretRiskSignals(scan, unitManifest);
  assert.deepEqual(signals.get("u1"), ["hardcoded_secret"]);
  assert.equal(signals.has("u2"), false);

  // Empty scan ⇒ empty map.
  assert.equal(secretRiskSignals({ findings: [] }, unitManifest).size, 0);

  // Merges cleanly into the risk register seam without throwing.
  const register = { items: [{ unit_id: "u1", risk_score: 0.5, signals: [] }] };
  const merged = mergeAnalyzerRiskSignals(register, signals);
  assert.ok(merged.items[0].signals.includes("hardcoded_secret"));
});

test("secretFindings groups by (rule, path), is security-lens, and never carries the raw secret", () => {
  const scan = {
    findings: [
      { rule_id: "aws-access-key-id", title: "AWS access key ID", path: "leak.ts", line: 1, severity: "high", confidence: "high", masked_excerpt: "AKIA…LE" },
      { rule_id: "aws-access-key-id", title: "AWS access key ID", path: "leak.ts", line: 9, severity: "high", confidence: "high", masked_excerpt: "AKIA…XY" },
    ],
  };
  const findings = secretFindings(scan);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].lens, "security");
  assert.equal(findings[0].category, "hardcoded_secret");
  assert.equal(findings[0].affected_files.length, 2);
  assert.match(findings[0].id, /^SEC-\d{3}$/);
  assert.deepEqual(secretFindings({ findings: [] }), []);
});

test("runStructureExecutor persists secrets.json and merges its signals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secret-struct-"));
  try {
    await writeFile(join(dir, "leak.ts"), `export const k = "${AWS_KEY}";\n`, "utf8");
    const repoManifest = await buildRepoManifestFromFs({ root: dir });
    const result = await runStructureExecutor({ repo_manifest: repoManifest }, dir);
    assert.ok(result.artifacts_written.includes("secrets.json"));
    assert.ok(result.updated.secrets);
    assert.ok(
      result.updated.secrets.findings.some((f) => f.path === "leak.ts"),
      "expected the leaked key to be scanned",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
