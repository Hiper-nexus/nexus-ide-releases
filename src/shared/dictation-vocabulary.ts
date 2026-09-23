/**
 * Vocabulário técnico do DITADO, compartilhado entre renderer e main.
 *
 * Vive em `shared` porque os dois lados consomem a MESMA lista por caminhos
 * diferentes: o renderer monta o prompt de priming do Whisper (bias de
 * vocabulário no decoder, via `dictation-output-mode`) e o main monta o
 * `custom_vocabulary` do Gemini (via `stt-service`). Uma lista só — duas
 * listas divergem no primeiro termo que alguém adicionar de um lado.
 *
 * Termos que a tradução literal costuma mutilar quando ditados em PT
 * ("comita e sobe pro worktree" → "commits and goes up to the worktree").
 */
export const DICTATION_CODE_VOCABULARY: readonly string[] = [
  'commit',
  'push',
  'branch',
  'worktree',
  'merge',
  'rebase',
  'deploy',
  'build',
  'test',
  'lint',
  'refactor',
  'rollback',
  'endpoint',
  'frontend',
  'backend',
  'terminal',
  'pane',
  'worker',
  'handoff',
  'mission',
  'squad',
  'pull request',
  'release',
];

/**
 * O priming do modo code é em INGLÊS de propósito: a API de translations do
 * Whisper condiciona o decoder em prompt EN, e a frase funciona como bias de
 * vocabulário, não como instrução seguida à risca.
 */
export const DICTATION_CODE_PRIMING_PROMPT =
  'Software engineering dictation for a coding agent, translated to clear ' +
  'imperative English without commentary. Technical vocabulary: ' +
  DICTATION_CODE_VOCABULARY.join(', ') +
  '.';

/**
 * Priming da transcrição LITERAL do CODE (a reescrita traduz depois). Em
 * português e sem falar em tradução: o Whisper segue o idioma e o estilo do
 * prompt, e um prompt em inglês sobre "traduzir" num pedido language=pt
 * puxava trechos em inglês, cortes e texto inventado — a reescrita partiria
 * de uma fonte já corrompida.
 */
export const DICTATION_CODE_LITERAL_PRIMING_PROMPT =
  'Ditado técnico em português para um agente de programação. Termos: ' +
  DICTATION_CODE_VOCABULARY.join(', ') +
  '.';
