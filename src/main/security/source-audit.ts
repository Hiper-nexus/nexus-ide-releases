import {
  auditContent,
  evidenceAt,
  SECRET_RE,
  type AuditFinding,
  type ContentAuditOptions,
  type ContentProvenance,
  type ContentAuditResult,
} from './content-audit';

const COMMAND_EXEC_RE = /\b(?:eval|exec|execFile|execSync|spawnSync|new\s+Function)\s*\(/i;
const INNER_HTML_RE = /\b(?:innerHTML|outerHTML|dangerouslySetInnerHTML)\b/i;
const ENV_READ_RE = /(?:readFileSync|readFile|open)\s*\([^\n]*(?:\.env|id_rsa|\.npmrc|\.aws)/i;

// F-1331: every excerpt goes through the shared evidenceAt, which redacts any
// secret in the window. The finding's own match is never redacted unless it
// is itself a secret (the exec sink must keep its `eval(`).
function sourceFinding(
  content: string,
  pattern: RegExp,
  finding: Omit<AuditFinding, 'line' | 'evidence'>,
): AuditFinding | null {
  const match = pattern.exec(content);
  if (!match) return null;
  return {
    ...finding,
    line: content.slice(0, match.index).split('\n').length,
    evidence: evidenceAt(content, match.index, match[0]),
  };
}

export function auditSourceCode(
  content: string,
  options: ContentAuditOptions = {},
): ContentAuditResult {
  const base = auditContent(content, {
    ...options,
    provenance: options.provenance ?? ('unknown' satisfies ContentProvenance),
  });
  const findings = [...base.findings];
  const candidates: Array<AuditFinding | null> = [
    sourceFinding(content, SECRET_RE, {
      severity: 'high',
      category: 'exfiltration',
      message: 'secret-like credential appears in source code; rotate rather than exposing it',
    }),
    sourceFinding(content, COMMAND_EXEC_RE, {
      severity: 'high',
      category: 'supply-chain',
      message: 'dynamic or process execution sink requires a trusted-input review',
    }),
    sourceFinding(content, INNER_HTML_RE, {
      severity: 'medium',
      category: 'unsafe-sink',
      message: 'HTML sink requires context-appropriate escaping or sanitization',
    }),
    sourceFinding(content, ENV_READ_RE, {
      severity: 'high',
      category: 'exfiltration',
      message: 'code reads a sensitive credential/configuration file',
    }),
  ];
  for (const candidate of candidates) {
    if (candidate) findings.push(candidate);
  }

  const rank: Record<ContentAuditResult['highestSeverity'], number> = {
    clean: 0,
    info: 1,
    low: 2,
    medium: 3,
    high: 4,
    critical: 5,
  };
  const highest = findings.reduce<ContentAuditResult['highestSeverity']>(
    (current, finding) => (rank[finding.severity] > rank[current] ? finding.severity : current),
    'clean',
  );
  return {
    ...base,
    highestSeverity: highest,
    actionable: findings.some((finding) => finding.severity !== 'info'),
    findings,
  };
}
