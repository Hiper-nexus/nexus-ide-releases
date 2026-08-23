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
  // Cobrança ativa (modelo Overclock, 19/08): o pane manda o handoff; se um
  // NÃO manda, o orquestrador chama ele. Missão real parou em "aguardar os
  // handoffs" com 2 handoffs já na fila e um worker mudo — o Maestro tem as
  // tools para puxar, não só esperar.
  '• COBRANÇA: entrega que não chega não é espera. Ao acordar, chame ' +
    'nexus_handoff_list({full:true}) ANTES de decidir qualquer coisa. Worker ' +
    'que já PAROU (idle/exited) sem handoff: leia o pane dele UMA vez ' +
    '(nexus_pane_read) e cobre a entrega com nexus_pane_write ' +
    '("finalize com nexus_handoff_submit"). Vale só para worker PARADO — ' +
    'worker vivo continua fora de vigília.',
  '• DELEGAÇÃO: abra cada worker com nexus_pane_spawn passando `prompt` — o pane ' +
    'nasce executando a tarefa (1 chamada, sem spawn+write). Relay FIEL do pedido ' +
    'humano: repasse a tarefa como veio, nunca adicione nem aperte restrições que ' +
    'o humano não pediu.',
  // Campo (14/08/2026): orquestrador claude respondeu SOZINHO uma tarefa
  // trivial ("apenas responda...") e a missão parou até o SLA de 90s do
  // delegation-supervisor escalar. A regra fecha essa brecha: NENHUM pedido
  // do objetivo é respondido no pane do orquestrador, por mais trivial que
  // pareça — se está no objetivo, é trabalho de worker.
  '• EXECUÇÃO: você NUNCA executa nem responde a tarefa no seu pane — TODO ' +
    'pedido do objetivo, inclusive uma pergunta trivial, vira dispatch de ' +
    'worker via nexus_pane_spawn. Seu texto próprio é só coordenação: plano, ' +
    'validação, veredito. EXCEÇÃO: meta-tarefa sobre os panes é SUA — worker ' +
    'não tem ferramenta de pane.',
  // Campo (20/08): resposta validada nos panes, missão eterna em running —
  // o worker já gastou seu único slot de handoff e ninguém mais submetia.
  // O Maestro PODE (canSubmitMissionHandoff aceita orchestrator).
  '• FECHO: entrega-resposta sem arquivo: submeta VOCÊ o handoff final ' +
    '(success, evidência citada) — é ele que conclui a missão.',
  '• WORKSPACE: modo same_checkout — 1 worker escritor por vez no mesmo diretório. ' +
    'Nada de git stash/reset/checkout/clean; não desfaça o trabalho de ninguém.',
  '• VOZ: o operador pode ditar em PT; o input pode chegar como inglês traduzido e ' +
    'otimizado para execução — trate como ditado traduzido de tarefa de software e ' +
    'responda em PT-BR.',
].join('\n');

export interface MaestroKickoffBriefInput {
  readonly title: string;
  readonly objective: string;
  readonly orchestratorName: string;
  readonly teamNames: readonly string[];
  readonly playbook?: string | null;
  readonly resume?: boolean;
  readonly uiNote?: string;
  /** Doutrina de segurança — o coordenador precisa dela ANTES de delegar. */
  readonly securityNote?: string;
  readonly designContext?: string;
  readonly lane?: string | null;
  readonly maxWorkers?: number | null;
  readonly executorCount?: number | null;
  readonly sealedPlanTitles?: readonly string[];
  /**
   * Missão-pergunta aos panes (meta-de-pane): o contrato completo já vai no
   * objetivo — doutrina de delegação aqui é CONTRADIÇÃO ("VOCÊ executa" vs
   * "delegue") e custava minutos de mull no kickoff real (1+1, 22/08).
   */
  readonly metaPane?: boolean;
}

/** Doutrina mínima da missão-pergunta — só o que NÃO está no meta bloco. */
const META_PANE_DOCTRINE = [
  'DOUTRINA (missão de pergunta):',
  '• ESPERA sem loop: nexus_pane_ask envia, espera e devolve a resposta; ' +
    'wait serve só para confirmar boot de pane recém-aberto.',
  '• FECHO único: um só nexus_handoff_submit com as respostas de TODOS os ' +
    'panes citadas; não chame set_status done — o motor conclui sozinho.',
  '• VOZ: ditado pode chegar traduzido para inglês; responda em PT-BR.',
].join('\n');

/**
 * Kickoff vivo do Maestro. Cabeçalho da missão + doutrina + playbook.
 * O plano selado já vem no `objective` quando o fast-lane o montou.
 */
export function buildMaestroKickoffBrief(
  input: MaestroKickoffBriefInput,
): string {
  const workers = input.teamNames.filter(
    (name) => name !== input.orchestratorName,
  );
  const playbook = input.playbook?.trim() ?? '';
  const planOnly =
    input.lane === 'plan' ||
    input.lane === 'consult' ||
    input.maxWorkers === 0;
  const sealedCount = input.sealedPlanTitles?.length ?? 0;
  const sealedHint =
    sealedCount > 0
      ? `Spawne UM worker por task selada pendente (first-wave). São ${sealedCount} entregas — não colapse em papéis.`
      : '';

  const metaPane = input.metaPane === true;
  const coordination = metaPane
    ? [
        '## ORQUESTRAÇÃO (missão de pergunta aos panes)',
        `Você é ${input.orchestratorName}. Aqui VOCÊ executa: abra os panes ` +
          `da equipe (${workers.join(', ') || 'equipe'}), colete TODAS as ` +
          'respostas e feche com o handoff final.',
        'O contrato completo está no bloco META-DE-PANE do objetivo — ele ' +
          'VENCE qualquer regra geral de delegação.',
      ].join('\n')
    : planOnly
    ? [
        '## ORQUESTRAÇÃO (modelo PULL)',
        `Papel: você é ${input.orchestratorName}. Esta missão é só documentação — ` +
          'escreva o plano em docs/plan.md (ou plan.md). Não abra trabalhadores.',
        'Quando o plano estiver pronto, chame nexus_mission_set_status({status:"done"}).',
      ].join('\n')
    : [
        '## ORQUESTRAÇÃO (modelo PULL)',
        `Papel: você é ${input.orchestratorName}, o coordenador. Não execute o pedido — delegue.`,
        workers.length > 0
          ? `Equipe para abrir: ${workers.join(', ')}.`
          : 'Equipe: abra trabalhadores conforme o objetivo pedir.',
        '1. Para cada tarefa: nexus_pane_spawn({agentName, prompt}) — uma chamada só. NUNCA spawn + write.',
        '2. Encerre o turno. Quando acordar, valide via nexus_handoff_list({full:true}).',
        '3. Worker parado sem handoff? Cobre: nexus_pane_read no pane dele + ' +
          'nexus_pane_write pedindo o nexus_handoff_submit. Nunca fique em ' +
          '"aguardando handoffs" com worker mudo já parado.',
        '4. Quando todos entregarem: nexus_mission_set_status({status:"done"}).',
        sealedHint,
      ]
        .filter(Boolean)
        .join('\n');

  return [
    `## Missão: ${input.title}`,
    `Objetivo: ${input.objective}`,
    input.uiNote?.trim() || '',
    input.securityNote?.trim() || '',
    input.designContext?.trim() || '',
    coordination,
    metaPane ? META_PANE_DOCTRINE : DOCTRINE_BASE,
    playbook
      ? `PLAYBOOK DO SQUAD (autoridade do operador, verbatim):\n${playbook}`
      : '',
    input.resume ? '(Você foi religado após uma tentativa anterior.)' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

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
