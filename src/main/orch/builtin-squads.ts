import type { Squad, SquadAgent } from '../../shared/orch-types';

/**
 * NEXUS ORIGINALS — squads embutidos, semeados no primeiro run (marcados
 * `builtin`) para que o Modo Squad funcione out-of-the-box, sem depender de
 * migração ou criação manual. O orquestrador roda SEMPRE no Claude (único CLI
 * que dirige o servidor MCP do Nexus de forma confiável); os workers podem ser
 * trocados no passo de revisão do wizard. Ids estáveis para não duplicar entre
 * versões; `createdAt` fixo para não churnar.
 */

const SEED_TS = '1704067200000'; // 2024-01-01, estável

/**
 * Allowlist mínima e explícita por papel (SEC#5 — antes `null` = irrestrito em
 * todos). O orquestrador é o dono da missão e usa o toolset completo; todo
 * worker é uma folha que só precisa entregar o handoff (nexus_handoff_submit é
 * sempre permitido), então seu `allowedTools` é `[]` — sem pane cross-access,
 * sem spawnar panes, sem controlar a missão. `allowedSkills` fica aberto de
 * propósito: skills rodam no contexto do próprio worker (não é vetor de escape
 * lateral) e workers legítimos precisam delas (ex.: impeccable no UX Designer).
 */
function withAllowlists(agents: SquadAgent[]): SquadAgent[] {
  return agents.map((agent) => ({
    ...agent,
    allowedTools:
      agent.allowedTools ?? (agent.category === 'orchestrator' ? null : []),
  }));
}

const RAW_SQUADS: Squad[] = [
  {
    id: 'nexus-fullstack',
    name: 'Full-Stack',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Full-Stack\n' +
      'Você é o orquestrador. Quebre a tarefa em frente, back e revisão; ' +
      'delegue cada parte ao worker correspondente via nexus_pane_* e ' +
      'integre os handoffs. O roster é um MENU: spawne só os agentes que a ' +
      'missão pede. Antes de finalizar: QA roda os testes/o app de verdade e ' +
      'tenta quebrar a entrega; Security revisa qualquer coisa que toque ' +
      'auth, pagamentos, rede ou dados de usuário; UX Designer critica e ' +
      'refina toda entrega com interface (hierarquia, estados vazios, ' +
      'acessibilidade, polish — use a skill impeccable se disponível). Só ' +
      'finalize com QA e Reviewer aprovando.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      // Workers em CLIs DIFERENTES (defaults editáveis no review): diversidade
      // de modelos = custo menor e sem sobrecarregar um provedor só.
      { id: 'frontend', agentName: 'Frontend', category: 'executor', cli: 'codex', effort: 'medium' },
      { id: 'backend', agentName: 'Backend', category: 'executor', cli: 'gemini', effort: 'medium' },
      { id: 'ux', agentName: 'UX Designer', category: 'reviewer', cli: 'claude', effort: 'medium' },
      { id: 'qa', agentName: 'QA', category: 'reviewer', cli: 'grok', effort: 'medium' },
      { id: 'security', agentName: 'Security', category: 'reviewer', cli: 'claude', effort: 'high' },
      { id: 'reviewer', agentName: 'Reviewer', category: 'reviewer', cli: 'kimi', effort: 'high' },
    ],
  },
  {
    id: 'nexus-review',
    name: 'Code Review',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Code Review\n' +
      'Você é o orquestrador. Envie o diff para os revisores em paralelo ' +
      '(correção, segurança e performance), colete os handoffs e consolide ' +
      'um veredito único, priorizando os achados por severidade.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      { id: 'correctness', agentName: 'Correctness', category: 'reviewer', cli: 'kimi', effort: 'high' },
      { id: 'security', agentName: 'Security', category: 'reviewer', cli: 'claude', effort: 'high' },
      { id: 'performance', agentName: 'Performance', category: 'reviewer', cli: 'gemini', effort: 'high' },
    ],
  },
  {
    id: 'nexus-research',
    name: 'Research & Arquitetura',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Research & Arquitetura\n' +
      'Você é o orquestrador. Mande os scouts levantarem o terreno em ' +
      'paralelo, sintetize os achados e peça ao arquiteto um plano de ' +
      'implementação com trade-offs. Depois passe o plano ao Contrarian ' +
      'para ele atacar (custos ocultos, riscos, alternativa mais simples) ' +
      'antes de qualquer código.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      { id: 'scout-a', agentName: 'Scout A', category: 'scout', cli: 'gemini', effort: 'medium' },
      { id: 'scout-b', agentName: 'Scout B', category: 'scout', cli: 'grok', effort: 'medium' },
      { id: 'architect', agentName: 'Architect', category: 'architect', cli: 'claude', effort: 'high' },
      { id: 'contrarian', agentName: 'Contrarian', category: 'reviewer', cli: 'kimi', effort: 'high' },
    ],
  },
];

/** Built-in squads with the per-role tool allowlists applied (SEC#5). */
export const BUILTIN_SQUADS: Squad[] = RAW_SQUADS.map((squad) => ({
  ...squad,
  agents: withAllowlists(squad.agents),
}));
