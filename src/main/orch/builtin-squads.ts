import type { Squad } from '../../shared/orch-types';

/**
 * NEXUS ORIGINALS — squads embutidos, semeados no primeiro run (marcados
 * `builtin`) para que o Modo Squad funcione out-of-the-box, sem depender de
 * migração ou criação manual. O orquestrador roda SEMPRE no Claude (único CLI
 * que dirige o servidor MCP do Nexus de forma confiável); os workers podem ser
 * trocados no passo de revisão do wizard. Ids estáveis para não duplicar entre
 * versões; `createdAt` fixo para não churnar.
 */

const SEED_TS = '1704067200000'; // 2024-01-01, estável

export const BUILTIN_SQUADS: Squad[] = [
  {
    id: 'nexus-fullstack',
    name: 'Full-Stack',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Full-Stack\n' +
      'Você é o orquestrador. Quebre a tarefa em frente, back e revisão; ' +
      'delegue cada parte ao worker correspondente via nexus_pane_* e ' +
      'integre os handoffs. Só finalize quando o reviewer aprovar.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      // Workers em CLIs DIFERENTES (defaults editáveis no review): diversidade
      // de modelos = custo menor e sem sobrecarregar um provedor só.
      { id: 'frontend', agentName: 'Frontend', category: 'executor', cli: 'codex', effort: 'medium' },
      { id: 'backend', agentName: 'Backend', category: 'executor', cli: 'gemini', effort: 'medium' },
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
      '(correção e segurança), colete os handoffs e consolide um veredito ' +
      'único, priorizando os achados por severidade.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      { id: 'correctness', agentName: 'Correctness', category: 'reviewer', cli: 'kimi', effort: 'high' },
      { id: 'security', agentName: 'Security', category: 'reviewer', cli: 'claude', effort: 'high' },
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
      'implementação com trade-offs antes de escrever código.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      { id: 'scout-a', agentName: 'Scout A', category: 'scout', cli: 'gemini', effort: 'medium' },
      { id: 'scout-b', agentName: 'Scout B', category: 'scout', cli: 'grok', effort: 'medium' },
      { id: 'architect', agentName: 'Architect', category: 'architect', cli: 'claude', effort: 'high' },
    ],
  },
];
