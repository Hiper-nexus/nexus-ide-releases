/**
 * Content-trust scan for catalog components (H1 mitigation).
 *
 * The marketplace installs agents/skills from a third-party community catalog.
 * The install transport is hardened (traversal/zip-slip/caps), but the *content*
 * carried no authenticity check: a malicious SKILL.md can instruct a full-auto
 * coding agent to exfiltrate credentials. This scanner is an automatic,
 * fail-closed policy applied at install time — it never prompts the user and
 * never touches the agent's autonomy. It refuses to publish content that
 * carries an unambiguous credential-exfiltration / reverse-shell / pipe-to-shell
 * pattern, and records lower-confidence signals as provenance warnings.
 *
 * Design bias: block only high-confidence *combinations* (a secret path piped to
 * the network, a reverse shell, `curl … | sh`). A bare mention of a credential
 * path is a warning, not a block, so legitimate skills keep installing.
 */

export type ThreatSeverity = 'block' | 'warn';

export interface ThreatFinding {
  readonly rule: string;
  readonly severity: ThreatSeverity;
  readonly detail: string;
}

// HIGH-signal secret locations: reading one of these has essentially no benign
// reason inside a marketplace skill. Combined with network egress → block.
const HIGH_SECRET_PATH_RE =
  /(\.claude\/\.credentials|\.credentials\.json|CLAUDE_CODE_OAUTH_TOKEN|\.ssh\/id_[a-z0-9]+|id_rsa|id_ed25519|\.aws\/credentials|\.config\/gcloud|gcloud\/credentials|find-generic-password|security\s+find-generic-password|\.nexus\/(?:secrets\.enc|managed-accounts|mcp-hub\.json))/i;

// LOWER-signal credential files that legitimate devops/publish skills reference
// (private registry auth, git creds). These only ever warn — never block — so a
// "publish to a private npm registry" skill is not refused.
const LOW_SECRET_PATH_RE = /(\.netrc|\.git-credentials|\.npmrc)/i;

// Network egress primitives.
const NET_EGRESS_RE =
  /(\bcurl\b|\bwget\b|\bnc\b|\bncat\b|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\bhttpie\b|\bxh\b|\bfetch\s*\(|requests\.(?:post|get)\s*\(|urllib|new\s+XMLHttpRequest|WebSocket\s*\()/i;

// Piping data into a shell interpreter (curl … | sh / bash / python).
const PIPE_TO_SHELL_RE =
  /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python[0-9.]*|node|perl|ruby|osascript)\b/i;

// Reverse-shell shapes.
const REVERSE_SHELL_RE =
  /(\/dev\/tcp\/|bash\s+-i\s*>?&?\s*\/dev\/tcp|nc\s+(?:-[a-z]*e|-[a-z]*c)\b|mkfifo\s+\/tmp\/|python[0-9.]*\s+-c\s+['"].*socket|socket\.socket\([^)]*\).*connect)/i;

// Obfuscated execution.
const OBFUSCATED_EXEC_RE =
  /(base64\s+(?:-d|--decode)\s*\|\s*(?:sh|bash|python)|eval\s*\(\s*(?:atob|Buffer\.from)|echo\s+[A-Za-z0-9+/=]{40,}\s*\|\s*base64\s+(?:-d|--decode))/i;

// Data upload flags commonly used to POST file contents.
const DATA_UPLOAD_RE =
  /(--data-binary\s+@|-d\s+@|--upload-file\b|-F\s+['"]?file=@|-T\s+)/i;

/** Split into lines but also keep a windowed view for proximity checks. */
function proximityHasBoth(text: string, a: RegExp, b: RegExp): boolean {
  // Same line, or within a small window of characters, counts as "combined".
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (a.test(line) && b.test(line)) return true;
  }
  // Cross-line window: slide a 400-char window and test both.
  const WINDOW = 400;
  for (let i = 0; i < text.length; i += WINDOW / 2) {
    const chunk = text.slice(i, i + WINDOW);
    if (a.test(chunk) && b.test(chunk)) return true;
  }
  return false;
}

/**
 * Scan a single text blob (SKILL.md, a script, a config) for threat patterns.
 * Pure and deterministic — unit-tested independently.
 */
export function scanTextForThreats(text: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];
  if (!text) return findings;

  // BLOCK: reverse shell and obfuscated exec are unambiguous.
  if (REVERSE_SHELL_RE.test(text)) {
    findings.push({
      rule: 'reverse-shell',
      severity: 'block',
      detail: 'reverse-shell pattern (e.g. /dev/tcp, nc -e)',
    });
  }
  if (OBFUSCATED_EXEC_RE.test(text)) {
    findings.push({
      rule: 'obfuscated-exec',
      severity: 'block',
      detail: 'base64/eval obfuscated code execution',
    });
  }
  // BLOCK: a HIGH-signal secret path combined with network egress or an upload
  // flag *in proximity* = credential exfiltration (the core skill→key-theft
  // chain). Proximity (not whole-file co-occurrence) avoids blocking a skill
  // that merely mentions a key path and, separately, uses the network.
  if (
    HIGH_SECRET_PATH_RE.test(text) &&
    (proximityHasBoth(text, HIGH_SECRET_PATH_RE, NET_EGRESS_RE) ||
      proximityHasBoth(text, HIGH_SECRET_PATH_RE, DATA_UPLOAD_RE))
  ) {
    findings.push({
      rule: 'credential-exfiltration',
      severity: 'block',
      detail: 'reads a known secret path and sends it over the network',
    });
  }

  // WARN: lower-confidence signals — recorded in provenance, never blocking, so
  // ordinary content-rich skills (rustup-style `curl | sh`, private-registry
  // publish) still install.
  if (proximityHasBoth(text, NET_EGRESS_RE, PIPE_TO_SHELL_RE)) {
    findings.push({
      rule: 'pipe-to-shell',
      severity: 'warn',
      detail: 'network fetch piped into a shell interpreter (curl … | sh)',
    });
  }
  if (HIGH_SECRET_PATH_RE.test(text) || LOW_SECRET_PATH_RE.test(text)) {
    findings.push({
      rule: 'secret-path-reference',
      severity: 'warn',
      detail: 'references a known credential/secret path',
    });
  }
  if (DATA_UPLOAD_RE.test(text)) {
    findings.push({
      rule: 'data-upload-flag',
      severity: 'warn',
      detail: 'uses a file-upload flag (curl --data-binary @/-F file=@)',
    });
  }

  return findings;
}

export interface ScanInput {
  readonly name: string;
  readonly buffer: Buffer;
}

export interface ScanResult {
  /** True when at least one BLOCK-severity finding was raised. */
  readonly blocked: boolean;
  /** Human-readable block reason (first block finding), if any. */
  readonly blockReason?: string;
  /** All non-blocking warnings (deduped, "<file>: <detail>"). */
  readonly warnings: string[];
}

/** True when a buffer is safe to treat as scannable UTF-8 text (skip binaries). */
function looksTextual(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  for (const byte of sample) {
    // NUL or most C0 control chars (except tab/newline/carriage/formfeed) → binary.
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) return false;
  }
  return true;
}

/**
 * Scan a set of downloaded component files. Only textual files are inspected
 * (images/binaries are skipped). Returns a blocking decision plus any warnings.
 */
export function scanComponentFiles(files: ScanInput[]): ScanResult {
  const warnings = new Set<string>();
  let blockReason: string | undefined;
  for (const file of files) {
    if (!looksTextual(file.buffer)) continue;
    const text = file.buffer.toString('utf8');
    for (const finding of scanTextForThreats(text)) {
      if (finding.severity === 'block') {
        if (!blockReason) blockReason = `${file.name}: ${finding.detail}`;
      } else {
        warnings.add(`${file.name}: ${finding.detail}`);
      }
    }
  }
  return {
    blocked: blockReason !== undefined,
    blockReason,
    warnings: [...warnings],
  };
}
