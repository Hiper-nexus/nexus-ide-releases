/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { MissionAgentSnapshot } from '../../../shared/mission-engine-contract';
import { MissionAgentCard } from './MissionAgentCard';

it.each([
  [false, 'Sem terminal ativo'],
  [true, 'Terminal ativo · Sem tarefa vinculada'],
])('o rack explica a presença física %s sem confundir com unidade em curso', (terminalLive, label) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<MissionAgentCard
    agent={{ id: 'rack', agentName: 'Rack', category: 'executor', cli: 'codex', state: 'queued', terminalLive } as MissionAgentSnapshot}
    position={{ x: 0, y: 0 }} selected={false} onSelectAgent={() => {}}
  />);
  expect(host.querySelector('.mission-agent-card__idle')?.textContent).toContain(label);
  expect(host.querySelector('button')?.getAttribute('aria-label')).toContain(label);
  expect(host.querySelector('.mission-agent-card__state')?.textContent).toBe('Na fila');
});

it.each([
  ['orchestrator', 540, '--mission-core-width'],
  ['orchestrator', 304, '--mission-core-width'],
  ['executor', 208, '--mission-rack-width'],
] as const)('o rack %s usa seu retângulo de %i px mesmo com um núcleo maior na superfície', (category, width, variable) => {
  const host = document.createElement('div');
  host.style.setProperty('--mission-core-width', '540px');
  host.innerHTML = renderToStaticMarkup(<MissionAgentCard
    agent={{ id: 'rack', agentName: 'Rack', category, cli: 'codex', state: 'working' } as MissionAgentSnapshot}
    position={{ x: 400, y: 500, width, height: category === 'orchestrator' ? 162 : 150 }}
    selected={false} onSelectAgent={() => {}}
  />);
  const card = host.querySelector('button')!;
  expect(card.style.getPropertyValue(variable)).toBe(`${width}px`);
});

it('absence of a linked task is explicit even with real activity detail', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<MissionAgentCard
    agent={{ id: 'direct', agentName: 'Agente direto', category: 'executor', cli: 'codex', state: 'working', detail: 'Atividade observada' } as MissionAgentSnapshot}
    position={{ x: 0, y: 0 }} selected={false} onSelectAgent={() => {}}
  />);
  expect(host.textContent).toContain('Sem tarefa vinculada');
  expect(host.querySelector('button')?.getAttribute('aria-label')).toContain('Sem tarefa vinculada');
  expect(host.textContent).toContain('Trabalhando');
  expect(host.textContent).toContain('Atividade observada');
});

it.each([false, true, undefined])('activity LEDs respect physical terminal presence %s', (terminalLive) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<MissionAgentCard
    agent={{ id: 'physical', agentName: 'Agente', category: 'executor', cli: 'codex', state: 'working', terminalLive } as MissionAgentSnapshot}
    position={{ x: 0, y: 0 }} selected={false} onSelectAgent={() => {}}
  />);
  expect(host.querySelector('button')?.getAttribute('data-activity-live')).toBe(terminalLive === false ? 'false' : 'true');
});

it('does not claim a current task when its referenced unit is missing from the same snapshot', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<MissionAgentCard
    agent={{ id: 'stale-unit', agentName: 'Agente', category: 'executor', cli: 'codex', state: 'working', terminalLive: true, currentUnitId: 'missing-unit' } as MissionAgentSnapshot}
    position={{ x: 0, y: 0 }} selected={false} onSelectAgent={() => {}}
  />);
  expect(host.textContent).toContain('Sem tarefa vinculada');
  expect(host.querySelector('.mission-agent-card__unit')).toBeNull();
  expect(host.querySelector('button')?.getAttribute('aria-label')).not.toContain('Unidade atual');
});
