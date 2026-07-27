const SENSITIVE_LINE_PATTERN =
  /^.*(?:senha|password|passphrase|api[\s_-]?key|secret|authorization|bearer|access[\s_-]?token|refresh[\s_-]?token|private[\s_-]?key).*$/gim;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;
const KNOWN_TOKEN_PATTERN =
  /\b(?:sk-(?:proj-)?|ghp_|gho_|ghu_|ghs_|github_pat_|npm_)[A-Za-z0-9_-]{8,}/giu;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;
const URL_CREDENTIAL_PATTERN =
  /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/giu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export const MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_REASON =
  'orchestrator_session_exited_before_first_dispatch';
export const MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_MARKER =
  '<!-- nexus:orchestrator-pre-dispatch-exit -->';
export const MISSION_ORCHESTRATOR_EXIT_OUTPUT_MAX_CHARS = 4_096;
export const MISSION_ORCHESTRATOR_EXIT_OUTPUT_MAX_LINES = 24;

/**
 * PTY tails can contain echoed credentials. Persist only a small, printable
 * diagnostic and redact whole credential-bearing lines before token patterns.
 */
export function sanitizeMissionOrchestratorExitOutput(raw: string): string {
  const printable = raw
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL_PATTERN, '')
    .replace(PRIVATE_KEY_PATTERN, '[private key redigida]')
    .replace(SENSITIVE_LINE_PATTERN, '[linha sensível redigida]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(KNOWN_TOKEN_PATTERN, '[token redigido]')
    .replace(AWS_ACCESS_KEY_PATTERN, '[access key redigida]')
    .replace(URL_CREDENTIAL_PATTERN, '$1[REDACTED]@')
    .trim();
  if (!printable) return '[sem saída capturada]';

  const lines = printable.split('\n');
  const boundedLines = lines.slice(
    Math.max(0, lines.length - MISSION_ORCHESTRATOR_EXIT_OUTPUT_MAX_LINES),
  );
  let bounded = boundedLines.join('\n');
  if (bounded.length > MISSION_ORCHESTRATOR_EXIT_OUTPUT_MAX_CHARS) {
    const prefix = '[...saída anterior omitida...]\n';
    bounded =
      prefix +
      bounded.slice(
        -(MISSION_ORCHESTRATOR_EXIT_OUTPUT_MAX_CHARS - prefix.length),
      );
  } else if (boundedLines.length < lines.length) {
    const prefix =
      `[...${lines.length - boundedLines.length} linhas omitidas...]\n`;
    bounded =
      prefix +
      bounded.slice(
        -(MISSION_ORCHESTRATOR_EXIT_OUTPUT_MAX_CHARS - prefix.length),
      );
  }
  return bounded;
}

export function missionOrchestratorExitDescription(
  existing: string,
): string {
  if (existing.includes(MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_MARKER)) {
    return existing;
  }
  const notice = [
    MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_MARKER,
    '## Maestro encerrou antes da delegação',
    'A sessão física do Maestro foi encerrada antes do primeiro dispatch. ' +
      'Nenhum worker foi iniciado por esta revisão.',
    '',
    `Código técnico: \`${MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_REASON}\`.`,
    'Use **Retomar missão** para abrir uma nova sessão e continuar com a ' +
      'intenção aprovada.',
  ].join('\n');
  return (existing.trim() ? `${notice}\n\n${existing}` : notice).slice(
    0,
    65_536,
  );
}
