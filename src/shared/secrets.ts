// Deterministic, dependency-free secret scanner — a truly OWN extractor signal
// (no ecosystem tool to acquire), the text/regex+entropy half of the own-vs-
// acquire policy. The pure detection logic lives here in shared (operates on an
// in-memory string, no filesystem) so it is reusable and trivially unit-testable;
// the audit extractor wraps it with file-walking + scoping. It NEVER throws and
// degrades to an empty list on any input.

/** A single detected potential secret, located to a file + 1-based line. */
export interface SecretFinding {
  /** The rule that matched (stable id, used for grouping / titles). */
  rule_id: string;
  /** Human title of the secret class. */
  title: string;
  /** Repo-relative path of the file the match was found in. */
  path: string;
  /** 1-based line number of the match. */
  line: number;
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  /**
   * Masked excerpt of the matched span — first/last few characters kept, the
   * middle replaced with `…`. The raw secret value is NEVER stored so the
   * artifact (committed as an audit deliverable) cannot itself leak a credential.
   */
  masked_excerpt: string;
}

/** The persisted `secrets.json` artifact: in-scope secret findings. */
export interface SecretScan {
  findings: SecretFinding[];
}

interface PatternRule {
  rule_id: string;
  title: string;
  /** Must be a global, single-line regex; capture group 1 (if present) is the secret span to mask. */
  regex: RegExp;
  severity: SecretFinding["severity"];
  confidence: SecretFinding["confidence"];
}

// High-signal, provider-specific token formats. These are confident matches —
// the format itself is the credential, not a heuristic on a variable name.
const PATTERN_RULES: PatternRule[] = [
  {
    rule_id: "aws-access-key-id",
    title: "AWS access key ID",
    regex: /\b((?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16})\b/g,
    severity: "high",
    confidence: "high",
  },
  {
    rule_id: "github-token",
    title: "GitHub token",
    regex: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[0-9A-Za-z_]{20,})\b/g,
    severity: "high",
    confidence: "high",
  },
  {
    rule_id: "gitlab-token",
    title: "GitLab personal access token",
    regex: /\b(glpat-[0-9A-Za-z_-]{20,})\b/g,
    severity: "high",
    confidence: "high",
  },
  {
    rule_id: "slack-token",
    title: "Slack token",
    regex: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g,
    severity: "high",
    confidence: "high",
  },
  {
    rule_id: "stripe-secret-key",
    title: "Stripe secret key",
    regex: /\b((?:sk|rk)_live_[0-9A-Za-z]{20,})\b/g,
    severity: "high",
    confidence: "high",
  },
  {
    rule_id: "google-api-key",
    title: "Google API key",
    regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    severity: "high",
    confidence: "high",
  },
  {
    rule_id: "npm-token",
    title: "npm access token",
    regex: /\b(npm_[0-9A-Za-z]{36})\b/g,
    severity: "high",
    confidence: "high",
  },
  {
    rule_id: "private-key-block",
    title: "Private key block",
    regex: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----)/g,
    severity: "high",
    confidence: "high",
  },
  {
    rule_id: "jwt",
    title: "JSON Web Token",
    regex: /\b(eyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,})\b/g,
    severity: "medium",
    confidence: "medium",
  },
  {
    rule_id: "basic-auth-url",
    title: "Credentials embedded in URL",
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@)/gi,
    severity: "high",
    confidence: "medium",
  },
];

// Generic "assignment of a secret-looking value to a secret-looking name". This
// is the heuristic tier (entropy-gated) — kept conservative to avoid noise: the
// LHS name must look credential-bearing AND the RHS value must be long and
// high-entropy AND not an obvious placeholder.
const SECRET_NAME = /(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|private[_-]?key|credential)/i;
const ASSIGNMENT =
  /\b([A-Za-z][A-Za-z0-9_.-]*)\s*[:=]\s*['"`]([^'"`\n]{16,})['"`]/g;
const ENTROPY_MIN = 4.0;
const PLACEHOLDER =
  /^(?:x{4,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|%[A-Za-z0-9_]+%|your[_-]?|example|changeme|placeholder|redacted|dummy|sample|test[_-]?|fake[_-]?|none|null|true|false)/i;

/** Shannon entropy (bits/char) of `value`. Empty string ⇒ 0. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Keep the first 4 and last 2 chars; mask the middle. Short spans fully masked. */
function maskSecret(span: string): string {
  if (span.length <= 8) return "…".repeat(Math.max(1, span.length));
  return `${span.slice(0, 4)}…${span.slice(-2)}`;
}

/**
 * Detect potential hardcoded secrets in `content` (the full text of `path`).
 * Pure: no IO, never throws. Returns findings sorted by (line, rule_id) for a
 * deterministic, stable order.
 */
export function detectSecrets(path: string, content: string): SecretFinding[] {
  if (!content) return [];
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    for (const rule of PATTERN_RULES) {
      rule.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.regex.exec(line)) !== null) {
        const span = match[1] ?? match[0];
        findings.push({
          rule_id: rule.rule_id,
          title: rule.title,
          path,
          line: lineNumber,
          severity: rule.severity,
          confidence: rule.confidence,
          masked_excerpt: maskSecret(span),
        });
        if (match.index === rule.regex.lastIndex) rule.regex.lastIndex++;
      }
    }

    ASSIGNMENT.lastIndex = 0;
    let assign: RegExpExecArray | null;
    while ((assign = ASSIGNMENT.exec(line)) !== null) {
      const name = assign[1];
      const value = assign[2];
      if (!SECRET_NAME.test(name)) continue;
      if (PLACEHOLDER.test(value)) continue;
      if (shannonEntropy(value) < ENTROPY_MIN) continue;
      findings.push({
        rule_id: "high-entropy-assignment",
        title: "High-entropy value assigned to a credential-named field",
        path,
        line: lineNumber,
        severity: "medium",
        confidence: "low",
        masked_excerpt: `${name}=${maskSecret(value)}`,
      });
    }
  }

  findings.sort((a, b) =>
    a.line !== b.line ? a.line - b.line : a.rule_id.localeCompare(b.rule_id),
  );
  return findings;
}
