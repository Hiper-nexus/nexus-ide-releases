import type { CSSProperties } from 'react';
import type { AgentCategory, Squad } from '../../shared/orch-types';
import type { PaneSessionState } from '../../shared/types';
import architectImage from '../assets/agent-mascots/architect.png';
import executorImage from '../assets/agent-mascots/executor.png';
import orchestratorImage from '../assets/agent-mascots/orchestrator.png';
import reviewerImage from '../assets/agent-mascots/reviewer.png';
import scoutImage from '../assets/agent-mascots/scout.png';

export type AgentVisualState = PaneSessionState | 'waiting' | 'done' | 'offline';
export type AgentAvatarSize = 'micro' | 'compact' | 'card';

const CATEGORY_IMAGES: Record<AgentCategory, string> = {
  orchestrator: orchestratorImage,
  scout: scoutImage,
  executor: executorImage,
  reviewer: reviewerImage,
  architect: architectImage,
};

const STATE_LABELS: Record<AgentVisualState, string> = {
  offline: 'configurado',
  spawning: 'iniciando',
  busy: 'trabalhando',
  idle: 'pronto',
  waiting: 'aguardando você',
  done: 'concluído',
  exited: 'encerrado',
  hibernated: 'dormindo',
};

function phaseFor(label: string): number {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return -(Math.abs(hash) % 1800);
}

export function resolveAgentCategory(
  squads: readonly Squad[],
  agentName?: string,
  role?: 'orchestrator' | 'worker',
): AgentCategory {
  if (role === 'orchestrator') return 'orchestrator';
  if (agentName) {
    for (const squad of squads) {
      const match = squad.agents.find(
        (agent) => agent.agentName === agentName || agent.id === agentName,
      );
      if (match) return match.category;
    }
  }
  return 'executor';
}

export function agentVisualStateLabel(state: AgentVisualState): string {
  return STATE_LABELS[state];
}

export function summarizeAgentStates(states: readonly AgentVisualState[]): string {
  if (states.length === 0) return 'sem agentes ativos';
  const count = (matches: readonly AgentVisualState[]) =>
    states.filter((state) => matches.includes(state)).length;
  const working = count(['busy']);
  const spawning = count(['spawning']);
  const ready = count(['idle', 'done']);
  const attention = count(['waiting', 'exited']);
  const sleeping = count(['hibernated']);
  const offline = count(['offline']);

  return [
    working > 0 ? `${working} trabalhando` : null,
    spawning > 0 ? `${spawning} iniciando` : null,
    attention > 0 ? `${attention} requer atenção` : null,
    ready > 0 ? `${ready} pronto${ready === 1 ? '' : 's'}` : null,
    sleeping > 0 ? `${sleeping} dormindo` : null,
    offline > 0 ? `${offline} configurado${offline === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function AgentCategoryIcon({ category }: { category: AgentCategory }) {
  switch (category) {
    case 'orchestrator':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );
    case 'scout':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
    case 'architect':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
      );
    case 'reviewer':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case 'executor':
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      );
  }
}

export function AgentAvatar({
  category,
  state = 'offline',
  size = 'compact',
  label,
  className,
}: {
  category: AgentCategory;
  state?: AgentVisualState;
  size?: AgentAvatarSize;
  label: string;
  className?: string;
}) {
  const stateLabel = agentVisualStateLabel(state);
  const style = {
    '--agent-phase': `${phaseFor(label)}ms`,
  } as CSSProperties;

  return (
    <span
      className={[
        'agent-avatar',
        `agent-avatar--${category}`,
        `agent-avatar--${state}`,
        `agent-avatar--${size}`,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      role="img"
      aria-label={`${label}, ${category}, ${stateLabel}`}
      title={`${label} · ${stateLabel}`}
      data-agent-state={state}
    >
      <img src={CATEGORY_IMAGES[category]} alt="" aria-hidden="true" className="agent-avatar__legacy-img" />
      <span className="agent-avatar__vector-glyph" aria-hidden="true">
        <AgentCategoryIcon category={category} />
      </span>
      <span className="agent-avatar__status-dot" aria-hidden="true" />
    </span>
  );
}
