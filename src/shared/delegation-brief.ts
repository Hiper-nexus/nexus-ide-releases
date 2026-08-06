/**
 * Delegação por PONTEIRO — brief persistido, worker escreve o resultado de volta.
 *
 * Hoje o briefing inteiro viaja no contexto de todo worker: caro em tokens,
 * caro no boot, e sem deixar rastro. O formato aqui é o do Overclock, medido em
 * disco: o brief vive num arquivo do WORKSPACE, o worker recebe uma LINHA de
 * ponteiro, executa, e escreve o resultado no MESMO arquivo sob `## Resultado`.
 *
 * Para o Nexus o ganho é duplo: corta contexto E deixa um ARTEFATO REVISÁVEL de
 * cada delegação — prompt efêmero não deixa rastro, brief em arquivo deixa, e
 * proveniência é a nossa essência.
 *
 * Puro: monta e lê texto. Quem grava o arquivo é o caminho de spawn.
 */

const RESULT_HEADING = '## Resultado';
const RESULT_PLACEHOLDER = '_(o worker preenche esta seção)_';

export interface DelegationBriefInput {
  readonly id: string;
  readonly title: string;
  readonly request: string;
}

export function buildDelegationBrief(input: DelegationBriefInput): string {
  return [
    `# ${input.title}`,
    '',
    `<!-- nexus-brief: ${input.id} -->`,
    '',
    '## Pedido',
    '',
    input.request.trim(),
    '',
    RESULT_HEADING,
    '',
    RESULT_PLACEHOLDER,
    '',
  ].join('\n');
}

/** A linha única que o worker recebe no lugar do briefing inteiro. */
export function briefPointerLine(brief: {
  readonly id: string;
  readonly path: string;
}): string {
  return (
    `Sua tarefa está em ${brief.path} — leia o arquivo, execute, e escreva o ` +
    `que fez na seção ${RESULT_HEADING} do MESMO arquivo antes de entregar o handoff.`
  );
}

/**
 * Resultado que o worker escreveu, ou `null` enquanto o placeholder continua lá.
 * Nunca devolve o placeholder como se fosse resposta — isso faria um brief não
 * executado parecer entregue.
 */
export function parseBriefResult(brief: string): string | null {
  const index = brief.indexOf(RESULT_HEADING);
  if (index < 0) return null;
  const body = brief.slice(index + RESULT_HEADING.length).trim();
  if (!body || body === RESULT_PLACEHOLDER) return null;
  return body;
}
