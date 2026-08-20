/**
 * O IPC do Electron só preserva `message` de erros do main — campos como
 * `remediation` da quarentena de identidade se perdem. Este helper recupera o
 * detalhe útil da mensagem e traduz as falhas conhecidas para uma instrução
 * acionável, em vez do genérico "Não foi possível abrir a pasta escolhida."
 */

const IPC_ENVELOPE_RE = /^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/;

const GENERIC_MESSAGE = 'Não foi possível abrir a pasta escolhida.';

const KNOWN_FAILURES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly guidance: string;
}> = [
  {
    pattern: /project manifest is incompatible|lineage/i,
    guidance:
      'O manifesto .nexus/project.json não bate com este repositório. ' +
      'Confirme a origem/histórico e regenere o manifesto, ou abra o clone correto.',
  },
  {
    pattern: /not authorized by the folder picker/i,
    guidance: 'Escolha a pasta novamente pelo seletor.',
  },
];

export function describeWorkspaceOpenError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? '');
  const detail = raw.replace(IPC_ENVELOPE_RE, '').trim();
  if (!detail) return GENERIC_MESSAGE;
  const known = KNOWN_FAILURES.find(({ pattern }) => pattern.test(detail));
  if (known) return `${GENERIC_MESSAGE} ${known.guidance}`;
  return `${GENERIC_MESSAGE} (${detail})`;
}
