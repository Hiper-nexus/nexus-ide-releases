import type { Mission, Squad } from '../../shared/orch-types';
import { isPaneMetaTask } from '../../shared/pane-meta-task';

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
  'DOUTRINA DE ORQUESTRAÇÃO:',
  '• ESPERA: delegar e encerrar o turno É esperar — a entrega cai no seu ' +
    'input ao ficar idle. NUNCA faça loop de nexus_pane_read/pane_wait_* em ' +
    'worker vivo; wait confirma boot. Olhar o que o pane N faz: ' +
    'nexus_pane_read UMA vez.',
  // Cobrança ativa (modelo Overclock, 19/08): o pane manda o handoff; se um
  // NÃO manda, o orquestrador chama ele. Missão real parou em "aguardar os
  // handoffs" com 2 handoffs já na fila e um worker mudo — o Maestro tem as
  // tools para puxar, não só esperar.
  '• COBRANÇA: entrega que não chega não é espera. Ao acordar, ' +
    'nexus_handoff_list({full:true}) ANTES de decidir. Worker PARADO sem handoff: nexus_pane_read UMA vez e cobre com ' +
    'nexus_pane_write ("finalize com nexus_handoff_submit").',
  // Campo (02/10): o Maestro Codex chamava nexus_route_task antes de cada
  // spawn — uma rodada inteira do modelo (~1 min) para nada: o spawn sem
  // adapterId já roteia, com reserva, na MESMA chamada.
  '• DELEGAÇÃO: trabalho sem dispatch → nexus_pane_spawn({task, prompt}) sem adapterId ' +
    'roteia e nasce executando. Relay FIEL do pedido humano, sem restrições extras.',
  // Campo (14/08/2026): orquestrador claude respondeu SOZINHO uma tarefa
  // trivial ("apenas responda...") e a missão parou até o SLA de 90s do
  // delegation-supervisor escalar. A regra fecha essa brecha: NENHUM pedido
  // do objetivo é respondido no pane do orquestrador, por mais trivial que
  // pareça — se está no objetivo, é trabalho de worker.
  '• EXECUÇÃO: você NUNCA executa missão no seu pane (só se pedido) — ' +
    'TODO pedido do objetivo, inclusive uma pergunta trivial, ' +
    'é dispatch de worker. Seu texto é coordenação; ' +
    'meta-tarefa sobre panes é SUA.',
  // Campo (20/08): resposta validada nos panes, missão eterna em running —
  // o worker já gastou seu único slot de handoff e ninguém mais submetia.
  // O Maestro PODE (canSubmitMissionHandoff aceita orchestrator).
  '• FECHO: entrega-resposta sem arquivo: submeta VOCÊ o handoff final ' +
    '(success, evidência citada) — o motor valida.',
  // F-714: a missão do HiperGO passou a noite de 30/09 em validações locais
  // de 40-140 min, uma depois da outra, sem nenhum worker adiantando nada.
  '• ESTEIRA: gate longo não para a missão: workers adiantam as ' +
    'próximas unidades; pesado local, um por vez.',
  '• WORKSPACE: same_checkout: 1 escritor por vez. Paralela: isolatedWriter:true ' +
    'e integre as branches ao final, na ordem de dependência. ' +
    'Leitura: readOnly:true, em paralelo. Preserve WIP; nada de stash/reset/checkout/clean.',
  // Campo (30/09): panes só liam e sinalizavam; diagnóstico virava entrega.
  // E cada hop "ler → reportar → abrir outro pane" custa uma rodada inteira:
  // o pane que leu já tem o contexto — ele mesmo resolve.
  '• CORREÇÃO: o pane lê E resolve no mesmo despacho; quem só sinalizou, mande executar; readOnly entrega texto.',
  // Regra do operador (02/10): o Maestro VERIFICA o que os workers entregam —
  // handoff é alegação, não prova. (Resumo de worker que diz "corrigido" sem
  // diff nem teste já fechou missão com a correção ausente.)
  '• VERIFIQUE: handoff é alegação, não prova — antes de aceitar/integrar, ' +
    'leia o diff e RODE você o teste que prova a correção; entrega de ' +
    'aparência: a prova é a captura do navegador; senão, "não verificado". ' +
    'Aceite com nexus_handoff_ack accepted.',
  // Regra do operador (01/10): escreve barato, julga caro — GLM/MiMo davam
  // "veredito APROVAR" em revisão de código.
  '• JULGAMENTO: código só integra/push após veredito de ponta — ' +
    'você (Fable/Opus/Sonnet/Sol 6.1/Astra) julga ou abre juiz via route_task ' +
    '"revisão"; barato nunca julga; sem juiz, você julga; registre com ' +
    'nexus_review_verdict. Escreva barato; o caro corrige.',
  '• VOZ: ditado traduzido chega em inglês; responda em PT-BR.',
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
  /**
   * F-781: regra "página web → navegador do Nexus" para o Maestro que alcança
   * o navegador. Na família Claude o hook ainda nega o WebFetch; nas outras
   * CLIs (Codex, Kimi, Grok…) o kickoff é o único lugar onde a regra chega.
   */
  readonly browserRule?: string;
  readonly designContext?: string;
  readonly lane?: string | null;
  readonly maxWorkers?: number | null;
  readonly executorCount?: number | null;
  readonly sealedPlanTitles?: readonly string[];
  /** O main gerencia a primeira onda, inclusive inicialização ainda em andamento. */
  readonly firstWaveDispatched?: boolean;
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
  '• PRIMEIRO ATO: nexus_pane_ask em cada integrante com SÓ a pergunta. ' +
    'NÃO liste panes, NÃO leia o grid, NÃO explique o plano — o main ' +
    'gerencia a inicialização dos panes da first-wave. Ausência transitória não autoriza duplicar pane.',
  '• ESPERA sem loop: nexus_pane_ask envia, espera e devolve a resposta; ' +
    'wait serve só para confirmar boot de pane recém-aberto.',
  '• FECHO único: um só nexus_handoff_submit com as respostas de TODOS os ' +
    'panes citadas; não chame set_status done — o motor conclui sozinho.',
  '• VOZ: ditado pode chegar traduzido para inglês; responda em PT-BR.',
].join('\n');

type DirectMode = 'consult' | 'plan' | 'solo';

function directMode(
  input: Pick<MaestroKickoffBriefInput, 'lane' | 'maxWorkers'>,
): DirectMode | null {
  if (input.lane === 'consult' || input.lane === 'plan') return input.lane;
  return input.maxWorkers === 0 ? 'solo' : null;
}

const HANDOFF_COMPLETION =
  'Submeta nexus_handoff_submit com status:"success" somente após validar a entrega real, ' +
  'summary descritivo (mínimo 20 caracteres) e artifacts listando arquivos ou [{fullText: "resposta e evidência reais"}]. ' +
  'Aceite do handoff não é confirmação de conclusão. Se a missão continuar running após o aceite, ' +
  'nexus_mission_set_status exige missionId atual, status:"done" e note descritiva de ao menos 40 caracteres. ' +
  'Respeite os gates: uma recusa exige resolver a causa ou registrar bloqueio, nunca anunciar sucesso sem confirmação do motor.';

function buildDirectDoctrine(mode: DirectMode): string {
  const execution = mode === 'consult'
    ? 'CONSULTA: responda e analise diretamente no seu pane, conforme o objetivo. Não crie arquivos sem solicitação.'
    : mode === 'plan'
      ? 'PLANEJAMENTO: elabore diretamente o plano conforme o objetivo, sem implementar a solução. ' +
        'Registre o plano em docs/plan.md (ou plan.md), exigido pelo gate desta modalidade, e inclua o plano completo no summary do handoff.'
      : 'EXECUÇÃO SEM WORKERS: execute o objetivo diretamente no seu pane, dentro do escopo autorizado; o orçamento de workers é zero.';
  return [
    'DOUTRINA (execução direta):',
    `• ${execution} Não abra trabalhadores.`,
    `• FECHO: ${HANDOFF_COMPLETION}`,
    '• WORKSPACE: preserve alterações existentes; nada de git stash/reset/checkout/clean para desfazer trabalho alheio.',
    '• VOZ: ditado traduzido pode chegar em inglês; responda em PT-BR.',
  ].join('\n');
}

function buildTeamCoordination(
  input: MaestroKickoffBriefInput,
  workers: readonly string[],
): string {
  const sealedCount = input.sealedPlanTitles?.length ?? 0;
  const dispatchInstruction = input.firstWaveDispatched
    ? 'O main gerencia a inicialização da first-wave, que pode estar parcial ou em andamento. ' +
      'Não duplique a first-wave: colete e valide seus handoffs com nexus_handoff_list({full:true}). ' +
      'Ausência momentânea de pane ou handoff não significa tarefa sem dispatch. ' +
      'Abra novas tarefas somente após confirmar que ainda não foram despachadas; substituições exigem falha confirmada e justificativa.'
    : 'Para cada tarefa ainda não despachada: nexus_pane_spawn({agentName, prompt}) — uma chamada só. NUNCA spawn + write.';
  return [
    '## ORQUESTRAÇÃO (modelo PULL)',
    `Papel: você é ${input.orchestratorName}, o coordenador. Não execute o pedido — delegue.`,
    `Equipe: ${workers.join(', ') || 'trabalhadores conforme o objetivo'}.`,
    `1. ${dispatchInstruction}`,
    '2. Encerre o turno. Quando acordar, valide via nexus_handoff_list({full:true}).',
    '3. Worker parado sem handoff? Cobre: nexus_pane_read no pane dele + ' +
      'nexus_pane_write pedindo o nexus_handoff_submit. Nunca fique em ' +
      '"aguardando handoffs" com worker mudo já parado.',
    `4. Quando todos entregarem e a validação estiver concluída: ${HANDOFF_COMPLETION}`,
    sealedCount > 0
      ? `Cada task selada pendente mantém sua entrega e seu dispatch; são ${sealedCount} entregas — não colapse em papéis nem duplique a first-wave.`
      : '',
  ].filter(Boolean).join('\n');
}

function buildMetaPaneCoordination(
  input: MaestroKickoffBriefInput,
  workers: readonly string[],
): string {
  return [
    '## ORQUESTRAÇÃO (missão de pergunta aos panes)',
    `Você é ${input.orchestratorName}. O main gerencia a inicialização da first-wave ` +
      `da equipe (${workers.join(', ') || 'equipe'}), que pode estar em andamento. NÃO chame ` +
      'nexus_pane_spawn. NÃO liste panes. PRIMEIRO ATO: nexus_pane_ask ' +
      'em cada integrante com a pergunta. Depois colete com ' +
      'nexus_handoff_list e feche com o handoff final.',
    'O contrato completo está no bloco META-DE-PANE do objetivo — ele ' +
      'VENCE qualquer regra geral de delegação.',
  ].join('\n');
}

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
  const playbook = input.playbook?.trim() ? input.playbook : '';
  const mode = directMode(input);
  const metaPane = input.metaPane === true;
  const coordination = metaPane
    ? buildMetaPaneCoordination(input, workers)
    : mode
      ? `## ORQUESTRAÇÃO (execução direta)\nPapel: você é ${input.orchestratorName}.`
      : buildTeamCoordination(input, workers);

  return [
    `## Missão: ${input.title}`,
    `Objetivo: ${input.objective}`,
    input.uiNote?.trim() || '',
    input.securityNote?.trim() || '',
    input.browserRule?.trim() || '',
    input.designContext?.trim() || '',
    coordination,
    metaPane ? META_PANE_DOCTRINE : mode ? buildDirectDoctrine(mode) : DOCTRINE_BASE,
    playbook
      ? `PLAYBOOK DO SQUAD (autoridade do operador, verbatim):\n${playbook}`
      : '',
    input.resume ? '(Você foi religado após uma tentativa anterior.)' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Doutrina permanente do Maestro (F-701). O kickoff leva a doutrina no 1º
 * prompt, e a compactação do contexto a dilui: em 30/09 o Maestro de uma
 * missão de dois dias passou a implementar sozinho, com trabalho sobrando e
 * nenhum worker vivo, até o operador pedir "solta mais panes". Estas linhas
 * vão nas `instructions` do MCP (prompt de sistema, sobrevive à compactação)
 * e, no Codex, pelo hook do prompt. Curta: repete só o que se perde.
 */
export const MAESTRO_STANDING_DOCTRINE = [
  'NEXUS — VOCÊ É O MAESTRO DESTA MISSÃO (vale a sessão inteira, também depois de compactar o contexto):',
  '1. Delegue: todo trabalho do objetivo (código, revisão, pesquisa, testes, correção de achados) vai para workers com nexus_pane_spawn({ task, prompt }). O Nexus escolhe CLI, modelo e esforço.',
  '2. Paralelo: abra juntos os workers independentes — readOnly: true nas leituras, isolatedWriter: true nas escritas. Trabalho restante sem worker vivo: abra agora, sem esperar o operador.',
  '3. Seu pane é coordenação: plano, briefs, integração das branches, validação e veredito. Não implemente nem revise, salvo pedido do operador.',
  '4. Brief de worker não contraria a autoridade de execução do Nexus (worktree, branch, sem push, sem clone próprio): o worker segue o Nexus e volta bloqueada.',
  '5. Depois de delegar, encerre o turno: a entrega chega sozinha. Ao acordar, nexus_handoff_list({full:true}).',
  // F-714: noite de 30/09 — 7h30 de validação em fila única, zero workers.
  '6. Esteira: gate longo (validador, suíte) não para a missão. Enquanto ele roda, adiante em workers as próximas unidades; só comando pesado local vai um por vez.',
  // Dever do operador (02/10): o Maestro confere o que os workers dizem ter feito.
  // F-782: a recusa vira rótulo — o Jev e a nota da rota aprendem com ela.
  '7. Verifique: handoff é alegação, não prova: leia o diff e RODE você o teste que prova a correção; entrega de aparência: a prova é a captura do navegador. Sem isso vale "não verificado". Aceite com nexus_handoff_ack verdict:"accepted". Rework: nexus_handoff_ack com verdict:"rework" e note ao mesmo writer, com o defeito concreto.',
  // F-781: a regra do navegador sobrevive à compactação também no Maestro
  // adotado (pane do operador) e nas CLIs sem o hook que nega o WebFetch.
  '8. Página web: navegador do Nexus (nexus_browser_open/read), não WebFetch; curl só para JSON de API.',
].join('\n');

/**
 * Doutrina permanente para a missão que DESPACHA workers. Execução direta
 * (consulta, plano, orçamento zero) e missão-pergunta aos panes têm doutrina
 * própria no kickoff, que contradiz "delegue" — ficam sem esta.
 */
export function maestroStandingDoctrine(
  mission: Pick<Mission, 'title' | 'description' | 'intentContract'> | null | undefined,
): string | null {
  if (!mission) return null;
  const mode = directMode({
    lane: mission.intentContract?.lane,
    maxWorkers: mission.intentContract?.budgets?.maxWorkers,
  });
  if (mode) return null;
  if (isPaneMetaTask(mission.title) || isPaneMetaTask(mission.description ?? '')) return null;
  return MAESTRO_STANDING_DOCTRINE;
}

/**
 * Monta a doutrina do orquestrador + (quando existir) o playbook do squad.
 * Nunca lança: squad ausente/instruções vazias degradam para a doutrina base.
 */
export function buildOrchestratorDoctrine(
  squad: Squad | null | undefined,
  mission: Mission,
): string {
  const mode = directMode({
    lane: mission.intentContract?.lane,
    maxWorkers: mission.intentContract?.budgets?.maxWorkers,
  });
  const doctrine = mode ? buildDirectDoctrine(mode) : DOCTRINE_BASE;
  const playbook = squad?.orchestratorInstructions;
  if (!playbook?.trim()) return doctrine;
  return `${doctrine}\n\nPLAYBOOK DO SQUAD (autoridade do operador, verbatim):\n${playbook}`;
}
