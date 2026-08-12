import type { Mission, Squad } from '../../shared/orch-types';

/**
 * Doutrina de orquestração da Via Rápida (2026-08-10).
 *
 * O kickoff do coordenador em `mission-fast-lane.ts` é deliberadamente curto
 * (papel + objetivo + equipe + PRONTO/BLOQUEADO). Isso deixava três buracos:
 * o coordenador não sabia (1) que delegar e encerrar o turno JÁ É esperar
 * (idle-delivery), caindo em loops de polling que reliam o próprio contexto;
 * (2) como delegar de forma fiel e a política de workspace do `same_checkout`;
 * (3) que o ditado do operador pode chegar traduzido para o inglês.
 *
 * Esta doutrina é anexada SÓ ao prompt do ORQUESTRADOR — os workers já têm o
 * `worker-handoff-contract.ts`, então não duplicamos o bloco de delegação para
 * eles. O playbook rico do squad (`squad.orchestratorInstructions`), que antes
 * nunca entrava no prompt vivo, é anexado verbatim depois da doutrina.
 *
 * Alvo: doutrina base curta (<2 KB). O playbook do operador não conta no alvo —
 * é autoridade dele, entra inteiro.
 */

/** Doutrina base — genérica, mesma tom direto do `agentPrompt`. */
const DOCTRINE_BASE = [
  'DOUTRINA DE ORQUESTRAÇÃO (só para a coordenação):',
  '• ESPERA: delegar e encerrar o turno É esperar. Quando um worker termina, ' +
    'a entrega é digitada no seu input assim que você fica idle (idle-delivery). ' +
    'NUNCA entre em loop de nexus_pane_read/pane_wait_* para vigiar worker vivo — ' +
    'isso não te ensina nada e re-lê seu contexto inteiro; use wait só para ' +
    'confirmar o boot de um pane recém-aberto. Se o humano pedir para olhar o ' +
    'que o pane N está fazendo, chame nexus_pane_read UMA vez (número falado: ' +
    '"7" ou "pane 7") — qualquer pane da missão lê o outro, inclusive você.',
  '• DELEGAÇÃO: abra cada worker com nexus_pane_spawn passando `prompt` — o pane ' +
    'nasce executando a tarefa (1 chamada, sem spawn+write). Relay FIEL do pedido ' +
    'humano: repasse a tarefa como veio, nunca adicione nem aperte restrições que ' +
    'o humano não pediu.',
  '• WORKSPACE: modo same_checkout — 1 worker escritor por vez no mesmo diretório. ' +
    'Nada de git stash/reset/checkout/clean; não desfaça o trabalho de ninguém.',
  '• VOZ: o operador pode ditar em PT; o input pode chegar como inglês traduzido e ' +
    'otimizado para execução — trate como ditado traduzido de tarefa de software e ' +
    'responda em PT-BR.',
].join('\n');

/**
 * Monta a doutrina do orquestrador + (quando existir) o playbook do squad.
 * Nunca lança: squad ausente/instruções vazias degradam para a doutrina base.
 */
export function buildOrchestratorDoctrine(
  squad: Squad | null | undefined,
  _mission: Mission,
): string {
  const playbook = squad?.orchestratorInstructions?.trim();
  if (!playbook) return DOCTRINE_BASE;
  return `${DOCTRINE_BASE}\n\nPLAYBOOK DO SQUAD (autoridade do operador, verbatim):\n${playbook}`;
}
