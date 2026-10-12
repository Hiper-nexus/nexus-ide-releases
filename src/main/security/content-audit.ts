import { createHash } from 'node:crypto';
import { redactSecretText } from '../../shared/secret-redaction';

export const CONTENT_AUDIT_MAX_CHARS = 256 * 1024;
const MAX_EVIDENCE_CHARS = 240;

export const CONTENT_PROVENANCES = [
  'unknown',
  'user',
  'repo-trusted',
  'repo-untrusted',
  'web-page',
  'mcp-tool-result',
  'mcp-tool-description',
  'file-external',
] as const;

export type ContentProvenance = (typeof CONTENT_PROVENANCES)[number];
export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AuditCategory =
  | 'override'
  | 'fake-structure'
  | 'hidden-unicode'
  | 'hidden-css'
  | 'html-comment'
  | 'exfiltration'
  | 'ssrf'
  | 'supply-chain'
  | 'repo-poisoning'
  | 'unsafe-sink';

export interface AuditFinding {
  severity: AuditSeverity;
  category: AuditCategory;
  message: string;
  line: number;
  evidence: string;
}

export interface ContentAuditResult {
  source: string;
  provenance: ContentProvenance;
  contentSha256: string;
  scannedChars: number;
  truncated: boolean;
  highestSeverity: AuditSeverity | 'clean';
  actionable: boolean;
  findings: AuditFinding[];
}

export interface ContentAuditOptions {
  source?: string;
  provenance?: ContentProvenance;
  artifactName?: string;
}

const SEVERITY_RANK: Record<AuditSeverity | 'clean', number> = {
  clean: 0,
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

const OVERRIDE_RE = /ignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i;
const FAKE_STRUCTURE_RE = /<\|(?:im_start|im_end|system|user|assistant)\|>|<<SYS>>|\[INST\]|###\s*(?:system|instruction|assistant):/i;
const HIDDEN_UNICODE_RE = /[\u200B\u200C\u200D\uFEFF\u2060\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u;
const HIDDEN_CSS_RE = /(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|color\s*:\s*(?:white|#fff)|left\s*:\s*-9999)/i;
const HTML_COMMENT_RE = /<!--[\s\S]*?(?:ignore|system|instruction|fetch|run|execute)[\s\S]*?-->/i;
const EXFIL_RE = /!\[[^\]]*\]\(\s*https?:\/\/[^)]*[?&](?:data|content|file|env|secret|key|token)=/i;
const SSRF_RE = /https?:\/\/(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.169\.254|metadata\.google\.internal)/i;
const CURL_PIPE_SHELL_RE = /(?:curl|wget)[^\n|]+\|\s*(?:sudo\s+)?(?:bash|sh|zsh)/i;
const INSTALL_HOOK_RE = /["'](?:pre|post)install["']\s*:/i;

function revealHidden(value: string): string {
  return value
    .replace(/\u200B/g, '[ZWSP]')
    .replace(/\u200C/g, '[ZWNJ]')
    .replace(/\u200D/g, '[ZWJ]')
    .replace(/\uFEFF/g, '[BOM]')
    .replace(/\u2060/g, '[WJ]')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '[BIDI]')
    .replace(/[\u{E0000}-\u{E007F}]/gu, '[UNICODE-TAG]');
}

/** Credential-like tokens. No evidence excerpt may carry one (F-1331). */
export const SECRET_RE = /(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|(?:api[_-]?key|auth[_-]?token|secret)\s*[:=]\s*["'][^"']{12,}["'])/i;
// Only ever used through matchAll, which clones it: no shared lastIndex state.
const SECRET_GLOBAL_RE = new RegExp(SECRET_RE.source, 'gi');

/**
 * F-1331 (revisão Fable): `const token = "…"` / `password: '…'` — quoted
 * assignment the shared command-line redactor does not see (lowercase name,
 * spaces around `=`). Only the value goes.
 */
const QUOTED_ASSIGN_SECRET_RE =
  /\b([\w.-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w-]*["']?\s*[:=]\s*)(["'])[^"'\n]{8,}\2/gi;
/** Widen the window to whole tokens so a prefix (ghp_, xoxb-, eyJ, scheme://) is never cut off. */
const EVIDENCE_WIDEN_LIMIT = 2048;

function redactEvidenceRange(content: string, start: number, end: number): string {
  // F-1331: secrets are found in the whole content, not in the excerpt, so one
  // cut by the window edge ("pi03-AAAA…") is still redacted.
  let raw = '';
  let cursor = start;
  for (const secret of content.matchAll(SECRET_GLOBAL_RE)) {
    const secretEnd = secret.index + secret[0].length;
    if (secretEnd <= start) continue;
    if (secret.index >= end) break;
    raw += `${content.slice(cursor, Math.max(cursor, secret.index))}[REDACTED_SECRET]`;
    cursor = secretEnd;
  }
  raw += content.slice(cursor, end);
  // F-1331 (revisão Fable): the shared patterns (ghp_, xoxb-, JWT,
  // scheme://user:pass@, Bearer, NAME=value…) — single source with the
  // terminal/memory redactor.
  return redactSecretText(raw).text.replace(QUOTED_ASSIGN_SECRET_RE, '$1$2[REDACTED]$2');
}

export function evidenceAt(content: string, index: number, match: string): string {
  let start = Math.max(0, index - 80);
  let end = Math.min(content.length, index + match.length + 80);
  const minStart = Math.max(0, start - EVIDENCE_WIDEN_LIMIT);
  const maxEnd = Math.min(content.length, end + EVIDENCE_WIDEN_LIMIT);
  while (start > minStart && !/\s/.test(content[start - 1]!)) start -= 1;
  while (end < maxEnd && !/\s/.test(content[end]!)) end += 1;
  const redacted = redactEvidenceRange(content, start, end);
  // Re-center on the match: cutting already-redacted text cannot leak.
  const lead = redactEvidenceRange(content, start, index).length;
  const raw = redacted.slice(Math.max(0, lead - 80), lead + match.length + 80);
  const excerpt = revealHidden(raw).replace(/\s+/g, ' ').trim();
  return excerpt.length > MAX_EVIDENCE_CHARS
    ? `${excerpt.slice(0, MAX_EVIDENCE_CHARS - 1)}…`
    : excerpt;
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function highestSeverity(findings: readonly AuditFinding[]): AuditSeverity | 'clean' {
  return findings.reduce<AuditSeverity | 'clean'>(
    (highest, finding) =>
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[highest]
        ? finding.severity
        : highest,
    'clean',
  );
}

function addMatch(
  findings: AuditFinding[],
  content: string,
  pattern: RegExp,
  severity: AuditSeverity,
  category: AuditCategory,
  message: string,
): void {
  const match = pattern.exec(content);
  if (!match || match.index === undefined) return;
  findings.push({
    severity,
    category,
    message,
    line: lineAt(content, match.index),
    evidence: evidenceAt(content, match.index, match[0]),
  });
}

export function auditContent(
  rawContent: string,
  options: ContentAuditOptions = {},
): ContentAuditResult {
  const content = rawContent.slice(0, CONTENT_AUDIT_MAX_CHARS);
  const findings: AuditFinding[] = [];

  addMatch(findings, content, OVERRIDE_RE, 'medium', 'override', 'visible instruction override phrase');
  addMatch(findings, content, FAKE_STRUCTURE_RE, 'medium', 'fake-structure', 'fake chat or system boundary marker');
  addMatch(findings, content, HIDDEN_UNICODE_RE, 'high', 'hidden-unicode', 'hidden or bidirectional Unicode control detected');
  addMatch(findings, content, HIDDEN_CSS_RE, 'high', 'hidden-css', 'hidden CSS can conceal instructions from a human reviewer');
  addMatch(findings, content, HTML_COMMENT_RE, 'high', 'html-comment', 'HTML comment contains imperative content');
  addMatch(findings, content, EXFIL_RE, 'high', 'exfiltration', 'markdown image URL carries a data-like query parameter');
  addMatch(findings, content, SSRF_RE, 'medium', 'ssrf', 'URL targets a private network or metadata endpoint');
  addMatch(findings, content, CURL_PIPE_SHELL_RE, 'high', 'supply-chain', 'remote script is piped directly into a shell');
  addMatch(findings, content, INSTALL_HOOK_RE, 'info', 'repo-poisoning', 'package install hook requires review before dependency installation');

  const artifact = options.artifactName?.toLowerCase();
  if (
    artifact &&
    /(?:^|\/)(?:agents\.md|claude\.md|\.cursorrules|\.windsurfrules|\.mcp\.json|\.aider\.conf\.yml|makefile)$/i.test(artifact)
  ) {
    findings.push({
      severity: 'info',
      category: 'repo-poisoning',
      message: 'agent or build instruction surface was explicitly audited',
      line: 1,
      evidence: artifact,
    });
  }

  const severity = highestSeverity(findings);
  return {
    source: options.source ?? 'unknown',
    provenance: options.provenance ?? 'unknown',
    contentSha256: createHash('sha256').update(rawContent).digest('hex'),
    scannedChars: content.length,
    truncated: rawContent.length > content.length,
    highestSeverity: severity,
    actionable: findings.some((finding) => finding.severity !== 'info'),
    findings,
  };
}
