import {
  auditContent,
  type AuditFinding,
  type ContentAuditOptions,
  type ContentProvenance,
  type ContentAuditResult,
} from './content-audit';

const SECRET_RE = /(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|(?:api[_-]?key|auth[_-]?token|secret)\s*[:=]\s*["'][^"']{12,}["'])/i;
const COMMAND_EXEC_RE = /\b(?:eval|exec|execFile|execSync|spawnSync|new\s+Function)\s*\(/i;
const INNER_HTML_RE = /\b(?:innerHTML|outerHTML|dangerouslySetInnerHTML)\b/i;
const ENV_READ_RE = /(?:readFileSync|readFile|open)\s*\([^\n]*(?:\.env|id_rsa|\.npmrc|\.aws)/i;

function redactedEvidence(content: string, match: RegExp): string | null {
  const found = match.exec(content);
  if (!found || found.index === undefined) return null;
  const start = Math.max(0, found.index - 80);
  const end = Math.min(content.length, found.index + found[0].length + 80);
  return content
    .slice(start, end)
    .replace(found[0], '[REDACTED_SECRET]')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function sourceFinding(
  content: string,
  pattern: RegExp,
  finding: Omit<AuditFinding, 'line' | 'evidence'>,
  redact = false,
): AuditFinding | null {
  const match = pattern.exec(content);
  if (!match || match.index === undefined) return null;
  return {
    ...finding,
    line: content.slice(0, match.index).split('\n').length,
    evidence: redact || finding.category === 'supply-chain'
      ? redactedEvidence(content, pattern) ?? finding.message
      : content.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80).replace(/\s+/g, ' ').slice(0, 240),
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
    }, true),
    sourceFinding(content, COMMAND_EXEC_RE, {
      severity: 'high',
      category: 'supply-chain',
      message: 'dynamic or process execution sink requires a trusted-input review',
    }),
    sourceFinding(content, INNER_HTML_RE, {
      severity: 'medium',
      category: 'override',
      message: 'HTML sink requires context-appropriate escaping or sanitization',
    }),
    sourceFinding(content, ENV_READ_RE, {
      severity: 'high',
      category: 'exfiltration',
      message: 'code reads a sensitive credential/configuration file',
    }, true),
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
