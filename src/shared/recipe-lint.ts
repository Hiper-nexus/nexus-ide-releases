import type { RecipeLintIssue } from './types';
import type { Squad } from './orch-types';

export interface RecipeLintCatalog {
  toolNames: string[];
  skillNames: string[];
}

export interface RecipeLintInput {
  squads: Squad[];
  catalog: RecipeLintCatalog;
}

const GAP_PREFIX = 'gap:';

function canonicalToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.startsWith('nexus_') ? lower.slice('nexus_'.length) : lower;
}

function canonicalSkillName(name: string): string {
  return name.trim().toLowerCase();
}

export function parseGapRef(value: string): { ref: string; reason: string } | null {
  const clean = value.trim();
  if (!clean.toLowerCase().startsWith(GAP_PREFIX)) return null;
  const rest = clean.slice(GAP_PREFIX.length).trim();
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const ref = rest.slice(0, sep).trim();
  const reason = rest.slice(sep + 1).trim();
  if (!ref || reason.length < 4) return null;
  return { ref, reason };
}

function validGap(value: string): boolean {
  return parseGapRef(value) !== null;
}

function lintRefs(args: {
  squad: Squad;
  agent: Squad['agents'][number];
  field: 'allowedTools' | 'allowedSkills';
  refs: string[] | null | undefined;
  valid: Set<string>;
  canonical: (value: string) => string;
}): RecipeLintIssue[] {
  if (args.refs == null) return [];
  const issues: RecipeLintIssue[] = [];
  for (const raw of args.refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const gap = parseGapRef(ref);
    if (gap) continue;
    if (ref.toLowerCase().startsWith(GAP_PREFIX) && !validGap(ref)) {
      issues.push({
        severity: 'error',
        squadId: args.squad.id,
        squadName: args.squad.name,
        agentId: args.agent.id,
        agentName: args.agent.agentName,
        field: args.field,
        ref,
        message:
          `Gap inválido. Use "gap:${args.canonical(ref)}: motivo" com um motivo claro.`,
      });
      continue;
    }
    if (!args.valid.has(args.canonical(ref))) {
      issues.push({
        severity: 'error',
        squadId: args.squad.id,
        squadName: args.squad.name,
        agentId: args.agent.id,
        agentName: args.agent.agentName,
        field: args.field,
        ref,
        message:
          `${args.field} referencia "${ref}", mas ele não existe no catálogo local. ` +
          `Troque por um nome real ou declare "gap:${ref}: motivo".`,
      });
    }
  }
  return issues;
}

export function lintSquadRecipes(input: RecipeLintInput): RecipeLintIssue[] {
  const tools = new Set<string>();
  for (const tool of input.catalog.toolNames) {
    tools.add(canonicalToolName(tool));
  }
  const skills = new Set(input.catalog.skillNames.map(canonicalSkillName));

  const issues: RecipeLintIssue[] = [];
  for (const squad of input.squads) {
    for (const agent of squad.agents) {
      if (agent.category !== 'orchestrator' && agent.allowedTools == null) {
        issues.push({
          severity: 'error',
          squadId: squad.id,
          squadName: squad.name,
          agentId: agent.id,
          agentName: agent.agentName,
          field: 'allowedTools',
          ref: '*',
          message:
            'Worker com tools irrestritas. Use uma lista explícita ou [] para bloquear tools.',
        });
      }
      issues.push(
        ...lintRefs({
          squad,
          agent,
          field: 'allowedTools',
          refs: agent.allowedTools,
          valid: tools,
          canonical: canonicalToolName,
        }),
        ...lintRefs({
          squad,
          agent,
          field: 'allowedSkills',
          refs: agent.allowedSkills,
          valid: skills,
          canonical: canonicalSkillName,
        }),
      );
    }
  }
  return issues;
}

export function countAgentCategories(squads: Squad[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const squad of squads) {
    for (const agent of squad.agents) {
      counts[agent.category] = (counts[agent.category] ?? 0) + 1;
    }
  }
  return counts;
}
